import crypto from 'node:crypto';
import { col, db, FieldValue, toDate } from '../lib/firestore.js';
import { config } from '../config.js';
import { fetchWithTimeout, readBody } from '../lib/http.js';
import { normalizePhone } from '../lib/utils.js';
import { logger } from '../lib/logger.js';
import { enqueue, RetryLater } from '../lib/tasks.js';
import { getAgent } from '../chat/agents.js';
import { createSession, getSession, appendMessages } from '../chat/sessions.js';
import { runTurn } from '../chat/engine.js';
import { transcribeAudio } from '../voice/voice.js';
import type { Campaign, Lead, WaLine } from '../types.js';

/* ------------------------------------------------------------------ */
/* Envío (WhatsApp Cloud API de Meta)                                  */
/* ------------------------------------------------------------------ */

export interface SendResult {
  ok: boolean;
  messageId?: string;
  httpStatus?: number;
  error?: { code?: number; subcode?: number; message: string; details?: string; type?: string };
}

const lineCache = new Map<string, { at: number; line: WaLine }>();
export async function getLine(id: string): Promise<WaLine | null> {
  const hit = lineCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.line;
  const s = await col.waLines().doc(id).get();
  if (!s.exists) return null;
  const line = { id: s.id, ...(s.data() as any) } as WaLine;
  lineCache.set(id, { at: Date.now(), line });
  return line;
}
export function invalidateLine(id: string) {
  lineCache.delete(id);
}
export async function getLineByPhoneNumberId(phoneNumberId: string): Promise<WaLine | null> {
  const q = await col.waLines().where('phoneNumberId', '==', phoneNumberId).limit(1).get();
  return q.empty ? null : ({ id: q.docs[0].id, ...(q.docs[0].data() as any) } as WaLine);
}

async function graphPost(line: WaLine, payload: any): Promise<SendResult> {
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${line.phoneNumberId}/messages`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${line.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
      timeoutMs: 20000,
    });
    const body: any = await readBody(res);
    if (!res.ok) {
      const err = body?.error || {};
      return {
        ok: false,
        httpStatus: res.status,
        error: {
          code: err.code,
          subcode: err.error_subcode,
          type: err.type,
          message: err.message || `HTTP ${res.status}`,
          details: err.error_data?.details,
        },
      };
    }
    return { ok: true, httpStatus: res.status, messageId: body?.messages?.[0]?.id };
  } catch (e: any) {
    return { ok: false, error: { message: `Integración no disponible: ${e?.message || e}` } };
  }
}

/** Convierte Markdown básico al formato de WhatsApp */
export function toWhatsAppText(md: string) {
  return md
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2')
    .trim();
}

export async function sendText(line: WaLine, to: string, text: string) {
  const parts: string[] = [];
  let rest = toWhatsAppText(text);
  while (rest.length > 4000) {
    const cut = rest.lastIndexOf('\n', 4000) > 1000 ? rest.lastIndexOf('\n', 4000) : 4000;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  let last: SendResult = { ok: true };
  for (const p of parts) if (p.trim()) last = await graphPost(line, { to, type: 'text', text: { body: p, preview_url: true } });
  return last;
}

export async function sendImage(line: WaLine, to: string, url: string, caption?: string) {
  return graphPost(line, { to, type: 'image', image: { link: url, ...(caption ? { caption } : {}) } });
}
export async function sendDocument(line: WaLine, to: string, url: string, filename: string) {
  return graphPost(line, { to, type: 'document', document: { link: url, filename } });
}

/** Texto + opciones (CTA) como botones (≤3) o lista (≤10) */
export async function sendWithOptions(line: WaLine, to: string, text: string, options: string[]) {
  const body = toWhatsAppText(text).slice(0, 1024);
  if (!options.length || text.length > 1024) {
    const r = await sendText(line, to, text);
    if (options.length) await sendText(line, to, options.map((o, i) => `${i + 1}. ${o}`).join('\n'));
    return r;
  }
  if (options.length <= 3 && options.every((o) => o.length <= 20)) {
    return graphPost(line, {
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: options.map((o, i) => ({ type: 'reply', reply: { id: `cta_${i}`, title: o } })) },
      },
    });
  }
  return graphPost(line, {
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      action: {
        button: 'Ver opciones',
        sections: [{ title: 'Opciones', rows: options.slice(0, 10).map((o, i) => ({ id: `cta_${i}`, title: o.slice(0, 24) })) }],
      },
    },
  });
}

export async function sendTemplate(
  line: WaLine,
  to: string,
  name: string,
  language: string,
  bodyParams: string[],
  headerImageUrl?: string,
): Promise<SendResult> {
  const components: any[] = [];
  if (headerImageUrl) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t || '-' })) });
  return graphPost(line, { to, type: 'template', template: { name, language: { code: language }, ...(components.length ? { components } : {}) } });
}

async function markRead(line: WaLine, messageId: string) {
  await graphPost(line, { status: 'read', message_id: messageId }).catch(() => undefined);
}

async function downloadMedia(line: WaLine, mediaId: string): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    const meta: any = await (
      await fetchWithTimeout(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${mediaId}`, {
        headers: { Authorization: `Bearer ${line.accessToken}` },
      })
    ).json();
    const res = await fetchWithTimeout(meta.url, { headers: { Authorization: `Bearer ${line.accessToken}` }, timeoutMs: 30000 });
    return { buf: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type };
  } catch (e) {
    logger.warn('Descarga de media WhatsApp falló', { error: e });
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

export function verifySignature(rawBody: Buffer | string, header?: string): boolean {
  if (!config.whatsapp.appSecret) return true; // en desarrollo
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Recibe el webhook, registra estados y encola mensajes entrantes (respuesta rápida a Meta) */
export async function handleWebhook(body: any) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const phoneNumberId = v.metadata?.phone_number_id;
      for (const st of v.statuses || []) {
        await handleStatus(st).catch((e) => logger.error('Error procesando estado WA', { error: e }));
      }
      for (const m of v.messages || []) {
        // Deduplicación: Meta reintenta webhooks
        const ref = col.waInbound().doc(m.id);
        try {
          await ref.create({ at: FieldValue.serverTimestamp(), phoneNumberId });
        } catch {
          continue;
        }
        const contactName = (v.contacts || []).find((c: any) => c.wa_id === m.from)?.profile?.name;
        await enqueue('wa-inbound', { phoneNumberId, message: m, contactName });
      }
    }
  }
}

const STATUS_RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3, REPLIED: 4 };

async function handleStatus(st: any) {
  const map = (await col.waMessages().doc(st.id).get()).data() as any;
  if (!map?.campaignId) return; // mensajes de conversación normal
  const status = String(st.status || '').toUpperCase(); // sent | delivered | read | failed
  const attemptRef = col.attempts(map.campaignId).doc(map.attemptId);
  const leadRef = col.leads(map.campaignId).doc(map.leadId);
  const errors = st.errors?.map((e: any) => ({ code: e.code, message: e.title || e.message, details: e.error_data?.details })) || null;
  await attemptRef.update({
    statusHistory: FieldValue.arrayUnion({ status, at: new Date(Number(st.timestamp) * 1000 || Date.now()).toISOString() }),
    ...(status === 'FAILED' ? { status: 'FAILED', error: errors?.[0] || { message: 'Fallo reportado por el canal' } } : { channelStatus: status }),
  });
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(leadRef);
    if (!snap.exists) return;
    const lead = snap.data() as Lead;
    if (lead.lastAttemptId !== map.attemptId) return;
    const counters: Record<string, any> = {};
    if (status === 'FAILED') {
      tx.update(leadRef, { status: 'FAILED', lastError: errors?.[0] || null });
      counters['counters.failed'] = FieldValue.increment(1);
    } else if ((STATUS_RANK[status] || 0) > (STATUS_RANK[lead.status] || 0)) {
      tx.update(leadRef, { status, [`${status.toLowerCase()}At`]: FieldValue.serverTimestamp() });
      if (status === 'DELIVERED') counters['counters.delivered'] = FieldValue.increment(1);
      if (status === 'READ') {
        counters['counters.read'] = FieldValue.increment(1);
        if (lead.status === 'SENT') counters['counters.delivered'] = FieldValue.increment(1);
      }
    }
    if (Object.keys(counters).length) tx.update(col.campaign(map.campaignId), counters);
  });
}

/* ------------------------------------------------------------------ */
/* Procesamiento de mensajes entrantes                                 */
/* ------------------------------------------------------------------ */

async function messageToContent(line: WaLine, m: any): Promise<{ blocks: any[]; text: string }> {
  switch (m.type) {
    case 'text':
      return { blocks: [{ type: 'text', text: m.text.body }], text: m.text.body };
    case 'button':
      return { blocks: [{ type: 'text', text: m.button.text }], text: m.button.text };
    case 'interactive': {
      const t = m.interactive.button_reply?.title || m.interactive.list_reply?.title || '';
      return { blocks: [{ type: 'text', text: t }], text: t };
    }
    case 'image': {
      const media = await downloadMedia(line, m.image.id);
      const caption = m.image.caption || 'El usuario envió una imagen.';
      if (media && media.buf.length < 4.5 * 1024 * 1024 && /image\/(jpeg|png|webp|gif)/.test(media.mime))
        return {
          blocks: [
            { type: 'image', source: { type: 'base64', media_type: media.mime.split(';')[0], data: media.buf.toString('base64') } },
            { type: 'text', text: caption },
          ],
          text: `[imagen] ${caption}`,
        };
      return { blocks: [{ type: 'text', text: caption }], text: caption };
    }
    case 'audio': {
      const media = await downloadMedia(line, m.audio.id);
      const transcript = media ? await transcribeAudio(media.buf, media.mime).catch(() => '') : '';
      const text = transcript ? `[nota de voz transcrita] ${transcript}` : '[El usuario envió una nota de voz que no se pudo transcribir. Pídele que escriba su mensaje.]';
      return { blocks: [{ type: 'text', text }], text };
    }
    case 'location': {
      const l = m.location;
      const text = `[ubicación compartida] ${l.name || ''} ${l.address || ''} (lat ${l.latitude}, lng ${l.longitude})`;
      return { blocks: [{ type: 'text', text }], text };
    }
    default:
      return { blocks: [{ type: 'text', text: `[El usuario envió un mensaje de tipo ${m.type} no soportado]` }], text: `[${m.type}]` };
  }
}

async function acquireLock(sessionId: string): Promise<boolean> {
  const ref = col.sessions().doc(sessionId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const until = (s.data() as any)?.lockUntil || 0;
    if (until > Date.now()) return false;
    tx.update(ref, { lockUntil: Date.now() + 90_000 });
    return true;
  });
}
const releaseLock = (sessionId: string) => col.sessions().doc(sessionId).update({ lockUntil: 0 });

export async function processInboundTask(p: { phoneNumberId: string; message: any; contactName?: string }) {
  const line = await getLineByPhoneNumberId(p.phoneNumberId);
  if (!line) {
    logger.warn('Mensaje para línea no registrada', { phoneNumberId: p.phoneNumberId });
    return;
  }
  const from = normalizePhone(p.message.from) || p.message.from;
  const routeRef = col.waContacts().doc(`${line.id}_${from}`);
  const route = ((await routeRef.get()).data() as any) || {};

  // ¿Pertenece a una campaña de Recovery?
  let campaign: Campaign | null = null;
  let lead: Lead | null = null;
  if (route.campaignId && route.leadId) {
    const cs = await col.campaign(route.campaignId).get();
    const ls = await col.leads(route.campaignId).doc(route.leadId).get();
    if (cs.exists && ls.exists) {
      campaign = { id: cs.id, ...(cs.data() as any) } as Campaign;
      lead = { id: ls.id, ...(ls.data() as any) } as Lead;
    }
  }

  const agentId = campaign?.agentId || route.agentId || line.defaultAgentId || (await findAgentForLine(line.id));
  const agent = agentId ? await getAgent(agentId) : null;
  if (!agent) {
    logger.warn('No hay agente asignado a la línea', { lineId: line.id });
    return;
  }

  // Sesión vigente o nueva
  let session = route.sessionId ? await getSession(route.sessionId) : null;
  const ttlMs = config.whatsapp.sessionTtlHours * 3600_000;
  const last = toDate(session?.lastActivityAt);
  const sameContext = session && (session.campaignId || null) === (campaign?.id || null);
  if (!session || !sameContext || (!campaign && last && Date.now() - last.getTime() > ttlMs)) {
    session = await createSession({
      agentId: agent.id,
      origin: campaign ? 'recovery' : 'standard',
      channel: 'whatsapp',
      campaignId: campaign?.id,
      leadId: lead?.id,
      lineId: line.id,
      userPhone: from,
      contact: lead
        ? { name: lead.firstName, lastName: lead.lastName, phone: lead.phone, email: lead.email, postalCode: lead.zip }
        : { phone: from, name: p.contactName },
    });
    if (campaign && lead) {
      // Mensaje inicial como contexto visible (no se envía al modelo; va en el prompt)
      await appendMessages(session.id, [
        { role: 'assistant', kind: 'outbound', content: [], excludeFromModel: true, channel: 'whatsapp', display: { text: route.templateText || `[Plantilla ${route.templateName || ''}]` } },
      ]);
      await col.leads(campaign.id).doc(lead.id).update({ sessionId: session.id });
    }
    await routeRef.set({ sessionId: session.id, agentId: agent.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  if (!(await acquireLock(session.id))) throw new RetryLater('Sesión ocupada');
  try {
    await markRead(line, p.message.id);
    if (campaign && lead) {
      if (!lead.repliedAt) {
        await col.leads(campaign.id).doc(lead.id).update({ status: 'REPLIED', repliedAt: FieldValue.serverTimestamp() });
        await col.campaign(campaign.id).update({ 'counters.replied': FieldValue.increment(1) });
        lead.status = 'REPLIED';
      }
    }
    const content = await messageToContent(line, p.message);
    const result = await runTurn({
      agent,
      session,
      channel: 'whatsapp',
      userContent: content.blocks,
      recovery: campaign && lead ? { campaign, lead, templateText: route.templateText } : null,
    });

    if (result.text) await sendWithOptions(line, from, result.text, result.ctas);
    for (const m of result.media) {
      if ((m.mimeType || '').startsWith('image/')) await sendImage(line, from, m.url, m.name);
      else await sendDocument(line, from, m.url, m.name);
    }
    for (const f of result.followUps) {
      await sendText(line, from, f);
      await appendMessages(session.id, [
        { role: 'assistant', kind: 'outbound', content: [], excludeFromModel: true, channel: 'whatsapp', display: { text: f } },
      ]);
    }
    if (campaign && lead && Object.values(campaign.evaluation || {}).some(Boolean)) {
      await enqueue('recovery-evaluate', { campaignId: campaign.id, leadId: lead.id, sessionId: session.id }, { delaySeconds: 20 });
    }
  } finally {
    await releaseLock(session.id);
  }
}

async function findAgentForLine(lineId: string): Promise<string | null> {
  const q = await col.agents().where('whatsapp.lineIds', 'array-contains', lineId).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}
