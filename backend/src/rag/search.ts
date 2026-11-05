import { col } from '../lib/firestore.js';
import { embedQuery } from '../lib/embeddings.js';
import { structured } from '../lib/claude.js';
import { logger } from '../lib/logger.js';
import type { Agent } from '../types.js';

export interface KnowledgeHit {
  title: string;
  url?: string | null;
  text: string;
  context?: string;
  score: number;
  documentId: string;
}

/**
 * Búsqueda semántica (Firestore Vector Search, distancia coseno) + reranking opcional con Claude.
 */
export async function searchKnowledge(agent: Agent, query: string, topK?: number): Promise<KnowledgeHit[]> {
  const k = topK || agent.rag?.topK || 6;
  const vector = await embedQuery(query);
  const candidates = agent.rag?.rerank ? Math.min(k * 3, 30) : k;
  const snap = await col
    .chunks()
    .where('agentId', '==', agent.id)
    .findNearest({
      vectorField: 'embedding',
      queryVector: vector,
      limit: candidates,
      distanceMeasure: 'COSINE',
      distanceResultField: '_distance',
    } as any)
    .get();

  let hits: KnowledgeHit[] = snap.docs.map((d: any) => {
    const x = d.data();
    return {
      title: x.title,
      url: x.url,
      text: x.text,
      context: x.context,
      documentId: x.documentId,
      score: 1 - (x._distance ?? 1), // similitud coseno
    };
  });
  const minScore = agent.rag?.minScore ?? 0.35;
  hits = hits.filter((h) => h.score >= minScore);

  if (agent.rag?.rerank && hits.length > k) {
    try {
      const { data } = await structured<{ ranking: number[] }>({
        system: 'Eres un sistema de reordenamiento para búsqueda. Evalúas qué fragmentos responden mejor a la consulta.',
        prompt: `Consulta: "${query}"\n\nFragmentos:\n${hits
          .map((h, i) => `[${i}] (${h.title}) ${h.text.slice(0, 700)}`)
          .join('\n\n')}\n\nDevuelve los índices de los ${k} fragmentos más útiles para responder, del más al menos relevante. Omite los irrelevantes.`,
        schema: {
          type: 'object',
          properties: { ranking: { type: 'array', items: { type: 'integer' } } },
          required: ['ranking'],
        },
        name: 'reordenar',
      });
      const ranked = (data.ranking || []).filter((i) => i >= 0 && i < hits.length).map((i) => hits[i]);
      if (ranked.length) hits = ranked.slice(0, k);
    } catch (e) {
      logger.warn('Rerank falló', { error: e });
      hits = hits.slice(0, k);
    }
  } else hits = hits.slice(0, k);
  return hits;
}
