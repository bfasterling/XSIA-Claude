import type { FastifyInstance } from 'fastify';
import { col, db, FieldValue, serialize } from '../../lib/firestore.js';
import { uploadBuffer } from '../../lib/storage.js';
import { enqueue } from '../../lib/tasks.js';
import { badRequest, conflict, notFound } from '../../lib/http.js';
import { normalizePhone, normalizeSearch, slugify } from '../../lib/utils.js';
import { config } from '../../config.js';
import {
  CAMPAIGN_DEFAULTS,
  cancelExecution,
  deleteCampaign,
  duplicateCampaign,
  getCampaign,
  pauseCampaign,
  prevalidate,
  resumeCampaign,
  retryLead,
  startCampaign,
  templateFor,
  templateParams,
  previewTemplate,
} from '../../recovery/campaigns.js';
import { LEAD_FIELDS, readTable, suggestMapping } from '../../recovery/imports.js';
import { campaignReport, exportCampaignCsv } from '../../recovery/reports.js';
import { suppress } from '../../recovery/suppression.js';
import { withDefaults } from '../../chat/agents.js';
import { listDisplayMessages } from '../../chat/sessions.js';
import { guard } from './guard.js';
import type { Lead } from '../../types.js';

const CAMPAIGN_EDITABLE = [
  'name',
  'description',
  'agentId',
  'actionFlowId',
  'agentInstructions',
  'templates',
  'secondAttemptTemplates',
  'promotions',
  'whatsapp',
  'rules',
  'crm',
  'evaluation',
];

export async function recoveryRoutes(app: FastifyInstance) {
  /* ---------------- Campañas ---------------- */
  app.get('/campaigns', async () => {
    const snap = await col.campaigns().orderBy('createdAt', 'desc').get();
    const items = snap.docs.map((d) => {
      const c: any = d.data();
      return serialize({ id: d.id, name: c.name, description: c.description, status: c.status, agentId: c.agentId, counters: c.counters || {}, createdAt: c.createdAt, updatedAt: c.updatedAt, lastTickNote: c.lastTickNote });
    });
    const totals = items.reduce(
      (t: any, c: any) => ({ campaigns: t.campaigns + 1, leads: t.leads + (c.counters.leads || 0), recovered: t.recovered + (c.counters.recovered || 0), running: t.running + (c.status === 'running' ? 1 : 0) }),
      { campaigns: 0, leads: 0, recovered: 0, running: 0 },
    );
    return { items, totals };
  });

  app.get('/campaigns/meta', async () => ({ leadFields: LEAD_FIELDS, maxRows: config.recovery.maxImportRows, maxBytes: config.recovery.maxImportBytes }));

  app.get('/campaigns/:id', async (req) => serialize(await getCampaign((req.params as any).id)));

  app.post('/campaigns', async (req) => {
    const b = (req.body || {}) as any;
    if (!b.name) throw badRequest('Nombre requerido');
    const ref = col.campaigns().doc();
    const data: any = withDefaults(CAMPAIGN_DEFAULTS as any, {});
    for (const k of CAMPAIGN_EDITABLE) if (k in b) data[k] = b[k];
    await ref.set({ ...data, status: 'draft', counters: {}, createdBy: req.user.email, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { id: ref.id };
  });

  app.patch('/campaigns/:id', async (req) => {
    const id = (req.params as any).id;
    const b = (req.body || {}) as any;
    await getCampaign(id);
    const patch: any = { updatedAt: FieldValue.serverTimestamp(), updatedBy: req.user.email };
    for (const k of CAMPAIGN_EDITABLE) if (k in b) patch[k] = b[k];
    await col.campaign(id).update(patch);
    return serialize(await getCampaign(id));
  });

  app.post('/campaigns/:id/duplicate', async (req) => ({ id: await duplicateCampaign((req.params as any).id, req.user.email) }));
  app.delete('/campaigns/:id', { preHandler: guard('admin') }, async (req) => {
    await deleteCampaign((req.params as any).id);
    return { ok: true };
  });

  /* ---------------- Ejecución ---------------- */
  app.get('/campaigns/:id/prevalidate', async (req) => prevalidate((req.params as any).id));
  app.post('/campaigns/:id/start', async (req) => startCampaign((req.params as any).id, req.user.email));
  app.post('/campaigns/:id/pause', async (req) => {
    await pauseCampaign((req.params as any).id, req.user.email);
    return { ok: true };
  });
  app.post('/campaigns/:id/resume', async (req) => {
    await resumeCampaign((req.params as any).id, req.user.email);
    return { ok: true };
  });
  app.post('/campaigns/:id/cancel', async (req) => cancelExecution((req.params as any).id, req.user.email));
  app.get('/campaigns/:id/executions', async (req) => {
    const snap = await col.executions((req.params as any).id).orderBy('startedAt', 'desc').limit(50).get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });
  /** Ejecuta un tick inmediato (útil en pruebas; normalmente lo hace Cloud Scheduler) */
  app.post('/campaigns/tick', async () => {
    await enqueue('recovery-tick', {});
    return { ok: true };
  });

  /** Vista previa del mensaje para un lead (plantilla + parámetros + promoción) */
  app.get('/campaigns/:id/leads/:leadId/preview', async (req) => {
    const { id, leadId } = req.params as any;
    const c = await getCampaign(id);
    const s = await col.leads(id).doc(leadId).get();
    if (!s.exists) throw notFound();
    const lead = { id: s.id, ...(s.data() as any) } as Lead;
    const t = templateFor(c, lead, (lead.attempts || 0) + 1);
    if (!t) return { error: `Sin plantilla para ${lead.type}` };
    const params = templateParams(c, t, lead);
    return { template: t.name, language: t.language, params, text: previewTemplate(t, params) };
  });

  /* ---------------- Importación de leads ---------------- */
  app.post('/campaigns/:id/imports/upload', async (req) => {
    const id = (req.params as any).id;
    await getCampaign(id);
    const file = await (req as any).file();
    if (!file) throw badRequest('Archivo requerido');
    const buf: Buffer = await file.toBuffer();
    if (buf.length > config.recovery.maxImportBytes) throw badRequest(`El archivo excede ${Math.round(config.recovery.maxImportBytes / 1048576)} MB`);
    if (!/\.(csv|xlsx)$/i.test(file.filename)) throw badRequest('Formatos admitidos: CSV y XLSX');
    const { columns, rows } = await readTable(buf, file.filename);
    if (!rows.length) throw badRequest('El archivo no contiene filas');
    const ref = col.batches(id).doc();
    const gcsPath = await uploadBuffer(`imports/${id}/${ref.id}/${slugify(file.filename.replace(/\.[^.]+$/, ''))}.${file.filename.split('.').pop()}`, buf, file.mimetype);
    await ref.set({
      fileName: file.filename,
      gcsPath,
      columns,
      totalInFile: rows.length,
      status: 'uploaded',
      createdBy: req.user.email,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      batchId: ref.id,
      columns,
      totalRows: rows.length,
      truncated: rows.length > config.recovery.maxImportRows,
      maxRows: config.recovery.maxImportRows,
      sample: rows.slice(0, 5),
      suggestedMapping: suggestMapping(columns),
    };
  });

  app.post('/campaigns/:id/imports/:batchId/commit', async (req) => {
    const { id, batchId } = req.params as any;
    const b = (req.body || {}) as any;
    const ref = col.batches(id).doc(batchId);
    const batch = (await ref.get()).data() as any;
    if (!batch) throw notFound('Lote no encontrado');
    if (batch.status !== 'uploaded') throw conflict('El lote ya fue procesado');
    if (!b.mapping?.phone) throw badRequest('El teléfono es obligatorio en el mapeo');
    if (!b.mapping?.type && !b.fixedType) throw badRequest('Mapea la columna de tipo o asigna un tipo fijo');
    await ref.update({ mapping: b.mapping, fixedType: b.fixedType || null, name: b.name || batch.fileName, status: 'queued' });
    await enqueue('recovery-import', { campaignId: id, batchId });
    return { ok: true };
  });

  app.get('/campaigns/:id/imports', async (req) => {
    const snap = await col.batches((req.params as any).id).orderBy('createdAt', 'desc').get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });

  /* ---------------- Leads ---------------- */
  app.get('/campaigns/:id/leads', async (req) => {
    const id = (req.params as any).id;
    const q = req.query as any;
    let query: FirebaseFirestore.Query = col.leads(id);
    if (q.eligible === 'true' || q.eligible === 'false') query = query.where('eligible', '==', q.eligible === 'true');
    if (q.status) query = query.where('status', '==', q.status);
    if (q.outcome) query = query.where('outcome', '==', q.outcome);
    if (q.type) query = query.where('type', '==', q.type);
    if (q.batchId) query = query.where('batchId', '==', q.batchId);
    if (q.search) {
      const term = normalizeSearch(String(q.search));
      const digits = term.replace(/\D/g, '');
      query = query.where('searchTokens', 'array-contains', digits.length >= 7 ? digits.slice(-10) : term.split(/\s+/)[0]);
    }
    if (q.cursor) {
      const c = await col.leads(id).doc(q.cursor).get();
      if (c.exists) query = query.orderBy('__name__').startAfter(c);
    }
    const limit = Math.min(Number(q.limit) || 25, 200);
    const snap = await query.limit(limit).get();
    return {
      items: snap.docs.map((d) => {
        const { searchTokens: _s, ...rest } = d.data() as any;
        return serialize({ id: d.id, ...rest });
      }),
      nextCursor: snap.size === limit ? snap.docs[snap.size - 1].id : null,
    };
  });

  app.get('/campaigns/:id/leads/:leadId', async (req) => {
    const { id, leadId } = req.params as any;
    const s = await col.leads(id).doc(leadId).get();
    if (!s.exists) throw notFound();
    const attempts = await col.attempts(id).where('leadId', '==', leadId).get();
    const lead: any = { id: s.id, ...s.data() };
    return serialize({
      lead,
      attempts: attempts.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a: any, b: any) => (a.attemptNumber || 0) - (b.attemptNumber || 0)),
      messages: lead.sessionId ? await listDisplayMessages(lead.sessionId, 300) : [],
    });
  });

  /** Edición de elegibilidad / datos del lead */
  app.patch('/campaigns/:id/leads/:leadId', async (req) => {
    const { id, leadId } = req.params as any;
    const b = (req.body || {}) as any;
    const ref = col.leads(id).doc(leadId);
    const lead = (await ref.get()).data() as Lead;
    if (!lead) throw notFound();
    const patch: any = { updatedAt: FieldValue.serverTimestamp(), updatedBy: req.user.email };
    for (const k of ['firstName', 'lastName', 'email', 'zip', 'brand', 'model', 'version', 'year', 'type', 'summary']) if (k in b) patch[k] = b[k];
    if ('eligible' in b) {
      if (b.eligible && (await col.suppressions().doc(lead.phone).get()).data()?.active) throw conflict('El teléfono está suprimido; retira la supresión primero');
      patch.eligible = !!b.eligible;
      patch.ineligibleReason = b.eligible ? null : b.reason || 'MANUAL';
      await col.campaign(id).update({ 'counters.eligible': FieldValue.increment(b.eligible === lead.eligible ? 0 : b.eligible ? 1 : -1) });
    }
    await ref.update(patch);
    return { ok: true };
  });

  /** Quitar lead de la campaña (no equivale a bloqueo global) */
  app.delete('/campaigns/:id/leads/:leadId', async (req) => {
    const { id, leadId } = req.params as any;
    const ref = col.leads(id).doc(leadId);
    const l = (await ref.get()).data() as Lead;
    if (!l) throw notFound();
    if (['SCHEDULED', 'SENDING'].includes(l.status)) throw conflict('El lead tiene un envío en curso');
    await ref.delete();
    await col.campaign(id).update({ 'counters.leads': FieldValue.increment(-1), ...(l.eligible ? { 'counters.eligible': FieldValue.increment(-1) } : {}) });
    return { ok: true };
  });

  /** Limpieza masiva por estado (solo leads no contactados) */
  app.post('/campaigns/:id/leads/purge', async (req) => {
    const id = (req.params as any).id;
    const b = (req.body || {}) as any;
    const allowed = ['PENDING', 'CANCELLED', 'FAILED'];
    if (!allowed.includes(b.status)) throw badRequest(`Solo se pueden retirar leads en estado ${allowed.join(', ')}`);
    let q: FirebaseFirestore.Query = col.leads(id).where('status', '==', b.status);
    if (b.eligible === false) q = q.where('eligible', '==', false);
    if (b.batchId) q = q.where('batchId', '==', b.batchId);
    const snap = await q.get();
    const w = db.bulkWriter();
    snap.docs.forEach((d) => w.delete(d.ref));
    await w.close();
    await col.campaign(id).update({ 'counters.leads': FieldValue.increment(-snap.size) });
    return { removed: snap.size };
  });

  /** Bloqueo global del teléfono (afecta todas las campañas) */
  app.post('/campaigns/:id/leads/:leadId/block', async (req) => {
    const { id, leadId } = req.params as any;
    const ref = col.leads(id).doc(leadId);
    const l = (await ref.get()).data() as Lead;
    if (!l) throw notFound();
    await suppress(l.phone, (req.body as any)?.reason || 'Bloqueo manual', `admin:${req.user.email}`, req.user.email);
    await ref.update({ eligible: false, ineligibleReason: 'SUPPRESSED', doNotContact: true });
    return { ok: true };
  });

  app.post('/campaigns/:id/leads/:leadId/retry', async (req) => {
    const { id, leadId } = req.params as any;
    await retryLead(id, leadId);
    return { ok: true };
  });

  /* ---------------- Reportes ---------------- */
  app.get('/campaigns/:id/report', async (req) => campaignReport((req.params as any).id, req.query as any));

  app.get('/campaigns/:id/attempts', async (req) => {
    const id = (req.params as any).id;
    const q = req.query as any;
    let query: FirebaseFirestore.Query = col.attempts(id);
    if (q.status) query = query.where('status', '==', q.status);
    const snap = await query.orderBy('createdAt', 'desc').limit(Math.min(Number(q.limit) || 100, 500)).get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });

  /** Resumen de errores agrupados por código/mensaje del canal */
  app.get('/campaigns/:id/errors', async (req) => {
    const id = (req.params as any).id;
    const snap = await col.attempts(id).where('status', '==', 'FAILED').limit(2000).get();
    const groups = new Map<string, any>();
    snap.docs.forEach((d) => {
      const e: any = d.get('error') || {};
      const key = `${e.code || 'sin código'}|${e.message || ''}`;
      const g = groups.get(key) || { code: e.code, message: e.message, details: e.details, count: 0, lines: new Set(), templates: new Set() };
      g.count++;
      g.lines.add(d.get('lineId'));
      if (d.get('template')) g.templates.add(d.get('template'));
      groups.set(key, g);
    });
    return [...groups.values()].map((g) => ({ ...g, lines: [...g.lines], templates: [...g.templates] })).sort((a, b) => b.count - a.count);
  });

  app.get('/campaigns/:id/export', async (req, reply) => {
    const id = (req.params as any).id;
    const c = await getCampaign(id);
    const csv = await exportCampaignCsv(id);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="campana-${slugify(c.name)}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(csv);
  });

  /** Buscar un teléfono en todas las campañas (útil para soporte) */
  app.get('/recovery/phone/:phone', async (req) => {
    const phone = normalizePhone((req.params as any).phone);
    if (!phone) throw badRequest('Teléfono inválido');
    const snap = await db.collectionGroup('leads').where('phone', '==', phone).get();
    const sup = await col.suppressions().doc(phone).get();
    return serialize({ phone, suppression: sup.exists ? sup.data() : null, leads: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  });
}
