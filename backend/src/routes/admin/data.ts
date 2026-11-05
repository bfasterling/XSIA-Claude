import type { FastifyInstance } from 'fastify';
import { col, serialize, Timestamp } from '../../lib/firestore.js';
import { listDisplayMessages, recordStats } from '../../chat/sessions.js';
import { notFound } from '../../lib/http.js';
import { listVoices } from '../../voice/voice.js';
import { dayKey } from '../../lib/utils.js';

export async function dataRoutes(app: FastifyInstance) {
  /** Data: historial de sesiones con filtros (fecha, sitio, origen, campaña, canal) */
  app.get('/agents/:id/sessions', async (req) => {
    const id = (req.params as any).id;
    const q = req.query as any;
    let query: FirebaseFirestore.Query = col.sessions().where('agentId', '==', id);
    if (q.origin) query = query.where('origin', '==', q.origin);
    if (q.campaignId) query = query.where('campaignId', '==', q.campaignId);
    if (q.siteKey) query = query.where('siteKey', '==', q.siteKey);
    if (q.channel) query = query.where('channel', '==', q.channel);
    if (q.from) query = query.where('startedAt', '>=', Timestamp.fromDate(new Date(q.from)));
    if (q.to) query = query.where('startedAt', '<=', Timestamp.fromDate(new Date(q.to + 'T23:59:59')));
    query = query.orderBy('startedAt', 'desc');
    if (q.cursor) {
      const c = await col.sessions().doc(q.cursor).get();
      if (c.exists) query = query.startAfter(c);
    }
    const limit = Math.min(Number(q.limit) || 50, 200);
    const snap = await query.limit(limit).get();
    return {
      items: snap.docs.map((d) => serialize({ id: d.id, ...d.data() })),
      nextCursor: snap.size === limit ? snap.docs[snap.size - 1].id : null,
    };
  });

  app.get('/sessions/:sid', async (req) => {
    const sid = (req.params as any).sid;
    const s = await col.sessions().doc(sid).get();
    if (!s.exists) throw notFound();
    const logs = await col.actionLogs().where('sessionId', '==', sid).limit(50).get();
    return serialize({
      session: { id: s.id, ...s.data() },
      messages: await listDisplayMessages(sid, 500),
      actions: logs.docs.map((d) => ({ id: d.id, ...d.data() })),
    });
  });

  /** Dashboard: indicadores agregados por día con desgloses */
  app.get('/agents/:id/dashboard', async (req) => {
    const id = (req.params as any).id;
    const q = req.query as any;
    const to = q.to || dayKey();
    const from = q.from || dayKey(new Date(Date.now() - 29 * 86400_000));
    const snap = await col.stats(id).where('date', '>=', from).where('date', '<=', to).orderBy('date').get();
    const days = snap.docs.map((d) => serialize(d.data()));
    const totals: any = { sessions: 0, interactions: 0, tokens: 0, costUsd: 0, leads: 0, byOrigin: {}, bySite: {}, byChannel: {}, byCampaign: {} };
    for (const d of days as any[]) {
      for (const k of ['sessions', 'interactions', 'tokens', 'costUsd', 'leads']) totals[k] += d[k] || 0;
      for (const g of ['byOrigin', 'bySite', 'byChannel', 'byCampaign']) {
        for (const [key, v] of Object.entries<any>(d[g] || {})) {
          const t = (totals[g][key] ||= { sessions: 0, interactions: 0, tokens: 0, costUsd: 0, leads: 0 });
          for (const k of Object.keys(t)) t[k] += v[k] || 0;
        }
      }
    }
    return { from, to, totals, days };
  });

  /**
   * Sincronización de datos de Recovery: recalcula estadísticas del agente a partir
   * de las sesiones de Recovery (no envía mensajes ni crea campañas).
   */
  app.post('/agents/:id/sync-recovery', async (req) => {
    const id = (req.params as any).id;
    const snap = await col.sessions().where('agentId', '==', id).where('origin', '==', 'recovery').select('startedAt', 'campaignId').get();
    const seen = new Set<string>();
    const existing = await col.stats(id).get();
    for (const d of existing.docs) for (const c of Object.keys((d.data() as any).byCampaign || {})) seen.add(c);
    let backfilled = 0;
    for (const s of snap.docs) {
      const cId = s.get('campaignId');
      if (cId && !seen.has(cId)) {
        await recordStats(id, { sessions: 1, origin: 'recovery', campaignId: cId, channel: 'whatsapp' });
        backfilled++;
      }
    }
    return { recoverySessions: snap.size, backfilled };
  });

  app.get('/voices', async (req) => listVoices(String((req.query as any).lang || 'es')));
}
