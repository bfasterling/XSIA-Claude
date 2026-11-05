import type { FastifyInstance } from 'fastify';
import { col, db, FieldValue, serialize } from '../../lib/firestore.js';
import { AGENT_DEFAULTS, getAgent, invalidateAgent, withDefaults } from '../../chat/agents.js';
import { invalidateKnowledgeSummary } from '../../chat/prompt.js';
import { badRequest, conflict, notFound } from '../../lib/http.js';
import { newId, slugify } from '../../lib/utils.js';
import { guard } from './guard.js';
import type { Agent } from '../../types.js';

const EDITABLE = [
  'name',
  'description',
  'status',
  'model',
  'instructions',
  'leadQualification',
  'rag',
  'webReferences',
  'externalApis',
  'actionFlows',
  'distribution',
  'whatsapp',
  'chatManager',
  'voice',
  'dealers',
  'slug',
];

async function ensureUniqueSlug(slug: string, exceptId?: string) {
  const q = await col.agents().where('slug', '==', slug).limit(2).get();
  if (q.docs.some((d) => d.id !== exceptId)) throw conflict(`El identificador de acceso "${slug}" ya está en uso`);
}

function sanitize(patch: any) {
  const out: any = {};
  for (const k of EDITABLE) if (k in patch) out[k] = patch[k];
  if (out.externalApis) {
    if (out.externalApis.length > 5) throw badRequest('Máximo 5 servicios externos por agente');
    out.externalApis = out.externalApis.map((a: any) => ({ ...a, id: a.id || newId('api_') }));
  }
  if (out.actionFlows) {
    if (out.actionFlows.length > 4) throw badRequest('Máximo 4 flujos de acción por agente');
    out.actionFlows = out.actionFlows.map((f: any) => {
      if (f.payloadTemplate?.trim()) {
        try {
          JSON.parse(f.payloadTemplate.replace(/\{\{[^}]+\}\}/g, 'x'));
        } catch {
          throw badRequest(`El payload del flujo "${f.name}" no es un JSON válido`);
        }
      }
      return { ...f, id: f.id || newId('flow_') };
    });
  }
  if (out.slug !== undefined) out.slug = slugify(out.slug);
  return out;
}

export async function agentRoutes(app: FastifyInstance) {
  app.get('/agents', async () => {
    const snap = await col.agents().orderBy('name').get();
    return snap.docs.map((d) => {
      const a: any = d.data();
      return serialize({
        id: d.id,
        name: a.name,
        slug: a.slug,
        description: a.description,
        status: a.status,
        channels: { web: a.distribution?.published !== false, whatsapp: !!a.whatsapp?.enabled, voice: !!a.voice?.enabled },
        updatedAt: a.updatedAt,
      });
    });
  });

  app.get('/agents/:id', async (req) => {
    const a = await getAgent((req.params as any).id, true);
    if (!a) throw notFound();
    return serialize(a);
  });

  app.post('/agents', async (req) => {
    const body = (req.body || {}) as any;
    if (!body.name) throw badRequest('Nombre requerido');
    const slug = slugify(body.slug || body.name);
    await ensureUniqueSlug(slug);
    const ref = col.agents().doc();
    const agent = withDefaults(AGENT_DEFAULTS as any, sanitize(body));
    await ref.set({ ...agent, name: body.name, slug, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: req.user.email });
    return { id: ref.id, slug };
  });

  app.patch('/agents/:id', async (req) => {
    const id = (req.params as any).id;
    const patch = sanitize(req.body || {});
    if (patch.slug) await ensureUniqueSlug(patch.slug, id);
    if (!(await col.agent(id).get()).exists) throw notFound();
    await col.agent(id).update({ ...patch, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.user.email });
    invalidateAgent(id);
    invalidateKnowledgeSummary(id);
    return serialize(await getAgent(id, true));
  });

  /** Duplica configuración (y opcionalmente conocimiento); no copia historial de uso */
  app.post('/agents/:id/duplicate', async (req) => {
    const id = (req.params as any).id;
    const { name, copyKnowledge = true } = (req.body || {}) as any;
    const src = await getAgent(id, true);
    if (!src) throw notFound();
    const newName = name || `${src.name} (copia)`;
    let slug = slugify(newName);
    if (!(await col.agents().where('slug', '==', slug).limit(1).get()).empty) slug = `${slug}-${newId().slice(0, 4)}`;
    const ref = col.agents().doc();
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src as any;
    await ref.set({
      ...rest,
      name: newName,
      slug,
      whatsapp: { enabled: false, lineIds: [] },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: req.user.email,
      duplicatedFrom: id,
    });
    const sites = await col.sites(id).get();
    const w = db.bulkWriter();
    sites.docs.forEach((s) => w.create(col.sites(ref.id).doc(), s.data()));
    if (copyKnowledge) {
      for (const sub of ['documents', 'datasets', 'media', 'webSources'] as const) {
        const snap = await (col as any)[sub](id).get();
        snap.docs.forEach((d: any) => w.create((col as any)[sub](ref.id).doc(d.id), d.data()));
      }
      const chunks = await col.chunks().where('agentId', '==', id).get();
      chunks.docs.forEach((c) => w.create(col.chunks().doc(), { ...c.data(), agentId: ref.id }));
    }
    await w.close();
    return { id: ref.id, slug };
  });

  app.delete('/agents/:id', { preHandler: guard('admin') }, async (req) => {
    const id = (req.params as any).id;
    const running = await col.campaigns().where('agentId', '==', id).where('status', '==', 'running').limit(1).get();
    if (!running.empty) throw conflict('El agente está asignado a una campaña en ejecución');
    const chunks = await col.chunks().where('agentId', '==', id).select().get();
    const w = db.bulkWriter();
    chunks.docs.forEach((c) => w.delete(c.ref));
    await w.close();
    await db.recursiveDelete(col.agent(id));
    invalidateAgent(id);
    return { ok: true };
  });

  /* ---- Multisitio / distribuidores del agente ---- */
  app.get('/agents/:id/sites', async (req) => {
    const snap = await col.sites((req.params as any).id).orderBy('name').get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });
  app.post('/agents/:id/sites', async (req) => {
    const id = (req.params as any).id;
    const b = (req.body || {}) as any;
    const key = slugify(b.key || b.name);
    if (!key) throw badRequest('Clave requerida');
    const dup = await col.sites(id).where('key', '==', key).limit(1).get();
    if (!dup.empty) throw conflict('La clave del sitio ya existe');
    const ref = await col.sites(id).add({
      key,
      name: b.name || key,
      dealerCode: b.dealerCode || '',
      instructions: b.instructions || '',
      params: b.params || {},
      enabled: b.enabled !== false,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: ref.id, key };
  });
  app.patch('/agents/:id/sites/:siteId', async (req) => {
    const { id, siteId } = req.params as any;
    const b = (req.body || {}) as any;
    const patch: any = {};
    for (const k of ['name', 'dealerCode', 'instructions', 'params', 'enabled']) if (k in b) patch[k] = b[k];
    await col.sites(id).doc(siteId).update(patch);
    return { ok: true };
  });
  app.delete('/agents/:id/sites/:siteId', async (req) => {
    const { id, siteId } = req.params as any;
    await col.sites(id).doc(siteId).delete();
    return { ok: true };
  });

  /** Prueba de una herramienta externa desde el administrador */
  app.post('/agents/:id/test-api', async (req) => {
    const { api, input } = (req.body || {}) as any;
    const { buildTools } = await import('../../chat/tools.js');
    const agent = (await getAgent((req.params as any).id, true)) as Agent;
    const fake: any = { agent: { ...agent, externalApis: [{ ...api, enabled: true }], actionFlows: [] }, session: { id: 'test', contact: {}, flowRuns: {} }, channel: 'web', media: [], followUps: [], emit: () => undefined, sessionPatch: {} };
    const tool = buildTools(fake, { hasDocs: false, hasDatasets: false, hasMedia: false }).find((t) => t.name.startsWith('api_'));
    if (!tool) throw badRequest('Configuración incompleta (URL requerida)');
    return tool.run(input || {}, fake);
  });
}
