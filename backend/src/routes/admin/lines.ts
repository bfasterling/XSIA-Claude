import type { FastifyInstance } from 'fastify';
import { col, FieldValue, serialize } from '../../lib/firestore.js';
import { badRequest, notFound } from '../../lib/http.js';
import { dayKey, maskSecret, normalizePhone } from '../../lib/utils.js';
import { invalidateLine, sendTemplate, sendText } from '../../channels/whatsapp.js';
import { guard } from './guard.js';
import { config } from '../../config.js';
import type { WaLine } from '../../types.js';

/** Líneas de WhatsApp globales (administrador de líneas) */
export async function lineRoutes(app: FastifyInstance) {
  app.get('/lines', async () => {
    const snap = await col.waLines().orderBy('name').get();
    const day = dayKey();
    return Promise.all(
      snap.docs.map(async (d) => {
        const l: any = d.data();
        const used = ((await col.lineUsage().doc(`${d.id}_${day}`).get()).data() as any)?.count || 0;
        return serialize({ id: d.id, ...l, accessToken: maskSecret(l.accessToken), usedToday: used });
      }),
    );
  });

  app.get('/lines/webhook-info', async () => ({
    callbackUrl: `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/whatsapp`,
    verifyTokenConfigured: !!config.whatsapp.verifyToken,
    appSecretConfigured: !!config.whatsapp.appSecret,
    graphVersion: config.whatsapp.graphVersion,
  }));

  app.post('/lines', { preHandler: guard('admin') }, async (req) => {
    const b = (req.body || {}) as any;
    if (!b.phoneNumberId || !b.accessToken) throw badRequest('phoneNumberId y accessToken son requeridos');
    const dup = await col.waLines().where('phoneNumberId', '==', b.phoneNumberId).limit(1).get();
    if (!dup.empty) throw badRequest('La línea ya está registrada');
    const ref = await col.waLines().add({
      name: b.name || b.displayPhone || b.phoneNumberId,
      phoneNumberId: String(b.phoneNumberId),
      wabaId: String(b.wabaId || ''),
      displayPhone: String(b.displayPhone || ''),
      accessToken: String(b.accessToken),
      enabled: b.enabled !== false,
      dailyLimit: Number(b.dailyLimit) || 250,
      defaultAgentId: b.defaultAgentId || '',
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: ref.id };
  });

  app.patch('/lines/:id', { preHandler: guard('admin') }, async (req) => {
    const id = (req.params as any).id;
    const b = (req.body || {}) as any;
    const patch: any = { updatedAt: FieldValue.serverTimestamp() };
    for (const k of ['name', 'wabaId', 'displayPhone', 'enabled', 'dailyLimit', 'defaultAgentId', 'phoneNumberId']) if (k in b) patch[k] = b[k];
    if (b.accessToken && !String(b.accessToken).includes('••')) patch.accessToken = b.accessToken;
    await col.waLines().doc(id).update(patch);
    invalidateLine(id);
    return { ok: true };
  });

  app.delete('/lines/:id', { preHandler: guard('admin') }, async (req) => {
    const id = (req.params as any).id;
    const used = await col.campaigns().where('whatsapp.lineIds', 'array-contains', id).where('status', '==', 'running').limit(1).get();
    if (!used.empty) throw badRequest('La línea participa en una campaña en ejecución; deshabilítala en lugar de eliminarla');
    await col.waLines().doc(id).delete();
    invalidateLine(id);
    return { ok: true };
  });

  /** Envío controlado de diagnóstico (texto libre requiere ventana de 24h; plantilla no) */
  app.post('/lines/:id/test', async (req) => {
    const id = (req.params as any).id;
    const b = (req.body || {}) as any;
    const snap = await col.waLines().doc(id).get();
    if (!snap.exists) throw notFound();
    const line = { id, ...(snap.data() as any) } as WaLine;
    const to = normalizePhone(b.to);
    if (!to) throw badRequest('Teléfono destino inválido');
    if (b.template)
      return sendTemplate(line, to, b.template, b.language || 'es_MX', (b.params || []).map(String), b.headerImageUrl || undefined);
    return sendText(line, to, b.text || 'Mensaje de prueba de XSIA Claude');
  });
}
