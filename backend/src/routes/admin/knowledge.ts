import type { FastifyInstance } from 'fastify';
import { col, db, FieldValue, serialize } from '../../lib/firestore.js';
import { uploadBuffer, deletePath, publicUrl, signedReadUrl } from '../../lib/storage.js';
import { enqueue } from '../../lib/tasks.js';
import { badRequest, notFound } from '../../lib/http.js';
import { deleteChunksFor } from '../../rag/ingest.js';
import { guessMime, claudeDescribeImage } from '../../rag/parsers.js';
import { createDataset, queryDataset } from '../../rag/datasets.js';
import { invalidateMediaCache } from '../../rag/media.js';
import { searchKnowledge } from '../../rag/search.js';
import { invalidateKnowledgeSummary } from '../../chat/prompt.js';
import { invalidateAgentFeatures } from '../../chat/engine.js';
import { getAgent } from '../../chat/agents.js';
import { config } from '../../config.js';
import { slugify } from '../../lib/utils.js';

async function readUpload(req: any) {
  const file = await req.file();
  if (!file) throw badRequest('Archivo requerido');
  const buf: Buffer = await file.toBuffer();
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(file.fields || {})) {
    const f: any = v;
    if (f && typeof f === 'object' && 'value' in f) fields[k] = String(f.value);
  }
  return { buf, filename: file.filename as string, mimetype: file.mimetype as string, fields };
}

const touch = (agentId: string) => {
  invalidateKnowledgeSummary(agentId);
  invalidateAgentFeatures(agentId);
  invalidateMediaCache(agentId);
};

export async function knowledgeRoutes(app: FastifyInstance) {
  /* ---------------- Repositorio de documentos ---------------- */
  app.get('/agents/:id/documents', async (req) => {
    const snap = await col.documents((req.params as any).id).orderBy('createdAt', 'desc').limit(1000).get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });

  app.post('/agents/:id/documents', async (req) => {
    const agentId = (req.params as any).id;
    const { buf, filename, mimetype, fields } = await readUpload(req);
    if (buf.length > config.rag.maxDocumentBytes) throw badRequest('Archivo demasiado grande');
    const ref = col.documents(agentId).doc();
    const gcsPath = await uploadBuffer(`agents/${agentId}/documents/${ref.id}/${slugify(filename) || 'archivo'}`, buf, guessMime(filename, mimetype));
    await ref.set({
      name: filename,
      title: fields.title || filename.replace(/\.[^.]+$/, ''),
      instructions: fields.instructions || '',
      mimeType: guessMime(filename, mimetype),
      size: buf.length,
      gcsPath,
      sourceType: 'file',
      status: 'queued',
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user.email,
    });
    await enqueue('ingest-document', { agentId, documentId: ref.id });
    touch(agentId);
    return { id: ref.id };
  });

  app.patch('/agents/:id/documents/:docId', async (req) => {
    const { id, docId } = req.params as any;
    const b = (req.body || {}) as any;
    const patch: any = {};
    for (const k of ['title', 'instructions']) if (k in b) patch[k] = b[k];
    await col.documents(id).doc(docId).update(patch);
    touch(id);
    return { ok: true };
  });

  app.post('/agents/:id/documents/:docId/reindex', async (req) => {
    const { id, docId } = req.params as any;
    const d = (await col.documents(id).doc(docId).get()).data() as any;
    if (!d) throw notFound();
    if (d.sourceType === 'web') throw badRequest('Las páginas web se reindexan desde su sitio');
    await col.documents(id).doc(docId).update({ status: 'queued' });
    await enqueue('ingest-document', { agentId: id, documentId: docId });
    return { ok: true };
  });

  app.delete('/agents/:id/documents/:docId', async (req) => {
    const { id, docId } = req.params as any;
    const ref = col.documents(id).doc(docId);
    const d = (await ref.get()).data() as any;
    if (!d) throw notFound();
    await deleteChunksFor(id, docId);
    if (d.gcsPath) await deletePath(d.gcsPath);
    await ref.delete();
    touch(id);
    return { ok: true };
  });

  /** Prueba de recuperación RAG desde el administrador */
  app.post('/agents/:id/knowledge/search', async (req) => {
    const agent = await getAgent((req.params as any).id, true);
    if (!agent) throw notFound();
    const { query } = (req.body || {}) as any;
    return serialize(await searchKnowledge(agent, String(query || '')));
  });

  /* ---------------- Bases de datos CSV ---------------- */
  app.get('/agents/:id/datasets', async (req) => {
    const snap = await col.datasets((req.params as any).id).orderBy('createdAt', 'desc').get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });
  app.post('/agents/:id/datasets', async (req) => {
    const agentId = (req.params as any).id;
    const { buf, filename, fields } = await readUpload(req);
    if (!/\.csv$/i.test(filename)) throw badRequest('Se requiere un archivo CSV');
    const id = await createDataset(agentId, fields.name || filename, fields.purpose || '', buf, filename);
    touch(agentId);
    return { id };
  });
  app.patch('/agents/:id/datasets/:dsId', async (req) => {
    const { id, dsId } = req.params as any;
    const b = (req.body || {}) as any;
    const patch: any = { updatedAt: FieldValue.serverTimestamp() };
    for (const k of ['name', 'purpose', 'columns', 'enabled']) if (k in b) patch[k] = b[k];
    await col.datasets(id).doc(dsId).update(patch);
    touch(id);
    return { ok: true };
  });
  app.post('/agents/:id/datasets/:dsId/query', async (req) => {
    const { id, dsId } = req.params as any;
    const b = (req.body || {}) as any;
    return queryDataset(id, dsId, b.filters || [], b.limit || 20);
  });
  app.delete('/agents/:id/datasets/:dsId', async (req) => {
    const { id, dsId } = req.params as any;
    const d = (await col.datasets(id).doc(dsId).get()).data() as any;
    if (d?.gcsPath) await deletePath(d.gcsPath);
    await col.datasets(id).doc(dsId).delete();
    touch(id);
    return { ok: true };
  });

  /* ---------------- Librería de archivos e imágenes ---------------- */
  app.get('/agents/:id/media', async (req) => {
    const snap = await col.media((req.params as any).id).orderBy('createdAt', 'desc').get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });
  app.post('/agents/:id/media', async (req) => {
    const agentId = (req.params as any).id;
    const { buf, filename, mimetype, fields } = await readUpload(req);
    const mime = guessMime(filename, mimetype);
    const ref = col.media(agentId).doc();
    const path = `agents/${agentId}/media/${ref.id}/${slugify(filename.replace(/\.[^.]+$/, ''))}.${filename.split('.').pop()}`;
    const gcsPath = await uploadBuffer(path, buf, mime, config.storage.mediaBucket);
    const url = config.storage.mediaPublic ? publicUrl(path) : await signedReadUrl(gcsPath);
    let description = fields.description || '';
    let tags: string[] = fields.tags ? fields.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
    // Descripción automática con visión de Claude si no se proporcionó
    if (!description && /^image\/(png|jpeg|webp|gif)$/.test(mime) && buf.length < 5 * 1024 * 1024) {
      try {
        const r = await claudeDescribeImage(buf, mime, 'media', filename);
        description = r.description;
        tags = [...new Set([...tags, ...r.tags])];
      } catch {
        /* opcional */
      }
    }
    await ref.set({
      name: fields.name || filename.replace(/\.[^.]+$/, ''),
      description,
      tags,
      url,
      gcsPath,
      mimeType: mime,
      size: buf.length,
      expiresAt: fields.expiresAt ? new Date(fields.expiresAt) : null,
      enabled: true,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user.email,
    });
    touch(agentId);
    return { id: ref.id, description, tags };
  });
  app.patch('/agents/:id/media/:mediaId', async (req) => {
    const { id, mediaId } = req.params as any;
    const b = (req.body || {}) as any;
    const patch: any = {};
    for (const k of ['name', 'description', 'tags', 'enabled']) if (k in b) patch[k] = b[k];
    if ('expiresAt' in b) patch.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
    await col.media(id).doc(mediaId).update(patch);
    touch(id);
    return { ok: true };
  });
  app.delete('/agents/:id/media/:mediaId', async (req) => {
    const { id, mediaId } = req.params as any;
    const d = (await col.media(id).doc(mediaId).get()).data() as any;
    if (d?.gcsPath) await deletePath(d.gcsPath);
    await col.media(id).doc(mediaId).delete();
    touch(id);
    return { ok: true };
  });

  /* ---------------- Conocimiento de sitios web ---------------- */
  app.get('/agents/:id/web-sources', async (req) => {
    const snap = await col.webSources((req.params as any).id).orderBy('createdAt', 'desc').get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });
  app.post('/agents/:id/web-sources', async (req) => {
    const agentId = (req.params as any).id;
    const b = (req.body || {}) as any;
    try {
      new URL(b.url);
    } catch {
      throw badRequest('URL inválida');
    }
    const ref = await col.webSources(agentId).add({
      url: b.url,
      role: b.role || '',
      sitemapUrl: b.sitemapUrl || '',
      pathPrefix: b.pathPrefix || '',
      urls: (b.urls || []).filter(Boolean),
      maxPages: Math.min(Number(b.maxPages) || 50, 500),
      status: 'queued',
      createdAt: FieldValue.serverTimestamp(),
    });
    await enqueue('crawl', { agentId, sourceId: ref.id });
    touch(agentId);
    return { id: ref.id };
  });
  app.post('/agents/:id/web-sources/:sid/recrawl', async (req) => {
    const { id, sid } = req.params as any;
    await col.webSources(id).doc(sid).update({ status: 'queued' });
    await enqueue('crawl', { agentId: id, sourceId: sid });
    return { ok: true };
  });
  app.delete('/agents/:id/web-sources/:sid', async (req) => {
    const { id, sid } = req.params as any;
    const docs = await col.documents(id).where('webSourceId', '==', sid).get();
    for (const d of docs.docs) await deleteChunksFor(id, d.id);
    const w = db.bulkWriter();
    docs.docs.forEach((d) => w.delete(d.ref));
    await w.close();
    await col.webSources(id).doc(sid).delete();
    touch(id);
    return { ok: true, removedPages: docs.size };
  });
}
