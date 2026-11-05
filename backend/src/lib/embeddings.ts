import { GoogleAuth } from 'google-auth-library';
import { config } from '../config.js';
import { fetchWithTimeout } from './http.js';
import { mapLimit } from './utils.js';

/**
 * Embeddings para la búsqueda vectorial del RAG.
 * Claude no expone un modelo de embeddings; Anthropic recomienda Voyage AI.
 * Por defecto se usa Vertex AI (nativo GCP, multilingüe, sin llaves adicionales).
 */
const gauth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export type EmbedTask = 'document' | 'query';

async function vertexEmbed(texts: string[], task: EmbedTask, titles?: string[]): Promise<number[][]> {
  const { vertexModel, vertexRegion, dimension } = config.embeddings;
  const url = `https://${vertexRegion}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${vertexRegion}/publishers/google/models/${vertexModel}:predict`;
  const token = await gauth.getAccessToken();
  // gemini-embedding-* acepta 1 instancia por llamada; text-*-embedding-* hasta 250
  const perCall = vertexModel.startsWith('gemini') ? 1 : 25;
  const groups: Array<{ start: number; items: string[] }> = [];
  for (let i = 0; i < texts.length; i += perCall) groups.push({ start: i, items: texts.slice(i, i + perCall) });
  const out: number[][] = new Array(texts.length);
  await mapLimit(groups, 4, async (g) => {
    const body = {
      instances: g.items.map((content, j) => ({
        content: content.slice(0, 8000),
        task_type: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        ...(task === 'document' && titles?.[g.start + j] ? { title: titles[g.start + j] } : {}),
      })),
      parameters: { outputDimensionality: dimension, autoTruncate: true },
    };
    let attempt = 0;
    for (;;) {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 60000,
      });
      if (res.status === 429 && attempt < 5) {
        attempt++;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`Vertex embeddings ${res.status}: ${await res.text()}`);
      const json: any = await res.json();
      json.predictions.forEach((p: any, j: number) => (out[g.start + j] = p.embeddings.values));
      break;
    }
  });
  return out;
}

async function voyageEmbed(texts: string[], task: EmbedTask): Promise<number[][]> {
  const { voyageApiKey, voyageModel, dimension } = config.embeddings;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const res = await fetchWithTimeout('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${voyageApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: texts.slice(i, i + 64),
        model: voyageModel,
        input_type: task,
        output_dimension: dimension,
      }),
      timeoutMs: 60000,
    });
    if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    for (const d of json.data) out.push(d.embedding);
  }
  return out;
}

export async function embed(texts: string[], task: EmbedTask, titles?: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  return config.embeddings.provider === 'voyage' ? voyageEmbed(texts, task) : vertexEmbed(texts, task, titles);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embed([text], 'query');
  return v;
}
