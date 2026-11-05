import { col, db, FieldValue } from '../lib/firestore.js';
import { downloadBuffer } from '../lib/storage.js';
import { embed } from '../lib/embeddings.js';
import { claude, textOf } from '../lib/claude.js';
import { config } from '../config.js';
import { chunkText, mapLimit } from '../lib/utils.js';
import { extractText } from './parsers.js';
import { logger } from '../lib/logger.js';
import type { Agent } from '../types.js';

/**
 * "Contextual Retrieval" (técnica de Anthropic): Claude genera una breve
 * contextualización de cada fragmento respecto del documento completo. El
 * documento se envía con cache_control para que solo se cobre una vez.
 */
async function contextualize(fullText: string, chunks: string[], title: string): Promise<string[]> {
  const doc = fullText.length > 180_000 ? null : fullText;
  return mapLimit(chunks, 4, async (chunk, i) => {
    const docPart = doc ?? fullText.slice(Math.max(0, fullText.indexOf(chunk.slice(0, 80)) - 20_000), fullText.indexOf(chunk.slice(0, 80)) + 20_000);
    try {
      const res = await claude().messages.create({
        model: config.claude.fastModel,
        max_tokens: 200,
        temperature: 0,
        system: [
          {
            type: 'text',
            text: `<documento titulo="${title.replace(/"/g, '')}">\n${docPart}\n</documento>`,
            ...(doc ? { cache_control: { type: 'ephemeral' } } : {}),
          } as any,
        ],
        messages: [
          {
            role: 'user',
            content: `Este es un fragmento del documento:\n<fragmento>\n${chunk}\n</fragmento>\nEscribe un contexto breve (1-2 oraciones, en el idioma del documento) que sitúe este fragmento dentro del documento para mejorar su recuperación en búsquedas (menciona producto, sección, tema). Responde solo con el contexto.`,
          },
        ],
      });
      return textOf(res as any).trim();
    } catch (e) {
      logger.warn('Contextualización falló para fragmento', { i, error: e });
      return '';
    }
  });
}

export async function deleteChunksFor(agentId: string, documentId: string) {
  const snap = await col.chunks().where('agentId', '==', agentId).where('documentId', '==', documentId).select().get();
  const writer = db.bulkWriter();
  snap.docs.forEach((d) => writer.delete(d.ref));
  await writer.close();
}

/** Fragmenta, contextualiza, vectoriza y guarda un texto como conocimiento del agente */
export async function indexText(opts: {
  agent: Agent;
  documentId: string;
  title: string;
  text: string;
  url?: string;
  sourceType: 'file' | 'web';
}) {
  const { agent, documentId, title, text, url, sourceType } = opts;
  const chunks = chunkText(text);
  const contexts = agent.rag?.contextualRetrieval ? await contextualize(text, chunks, title) : chunks.map(() => '');
  const toEmbed = chunks.map((c, i) => `${title}\n${contexts[i] ? contexts[i] + '\n' : ''}${c}`);
  const vectors = await embed(toEmbed, 'document', chunks.map(() => title));

  await deleteChunksFor(agent.id, documentId);
  const writer = db.bulkWriter();
  chunks.forEach((c, i) => {
    writer.create(col.chunks().doc(), {
      agentId: agent.id,
      documentId,
      sourceType,
      title,
      url: url || null,
      order: i,
      text: c,
      context: contexts[i] || '',
      embedding: FieldValue.vector(vectors[i]),
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  await writer.close();
  return chunks.length;
}

/** Tarea: procesa un documento subido */
export async function ingestDocumentTask({ agentId, documentId }: { agentId: string; documentId: string }) {
  const ref = col.documents(agentId).doc(documentId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const d: any = snap.data();
  const agentSnap = await col.agent(agentId).get();
  const agent = { id: agentId, ...(agentSnap.data() as any) } as Agent;
  try {
    await ref.update({ status: 'processing', error: null });
    const buf = await downloadBuffer(d.gcsPath);
    const ex = await extractText(buf, d.name, d.mimeType);
    if (!ex.text.trim()) throw new Error('No se encontró texto en el documento');
    const n = await indexText({ agent, documentId, title: d.title || d.name, text: ex.text, sourceType: 'file' });
    await ref.update({
      status: 'ready',
      chunks: n,
      chars: ex.text.length,
      extractMethod: ex.method,
      preview: ex.text.slice(0, 600),
      processedAt: FieldValue.serverTimestamp(),
    });
  } catch (e: any) {
    logger.error('Ingesta de documento falló', { agentId, documentId, error: e });
    await ref.update({ status: 'error', error: String(e?.message || e) });
  }
}
