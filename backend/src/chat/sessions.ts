import { col, db, FieldValue } from '../lib/firestore.js';
import { dayKey } from '../lib/utils.js';
import type { Channel, Contact, Origin, Session } from '../types.js';
import type { Usage } from '../lib/claude.js';

export async function createSession(p: {
  agentId: string;
  origin: Origin;
  channel: Channel;
  siteKey?: string | null;
  campaignId?: string | null;
  leadId?: string | null;
  lineId?: string | null;
  userPhone?: string | null;
  contact?: Contact;
  meta?: Record<string, any>;
}): Promise<Session> {
  const ref = col.sessions().doc();
  const data = {
    agentId: p.agentId,
    origin: p.origin,
    channel: p.channel,
    siteKey: p.siteKey || null,
    campaignId: p.campaignId || null,
    leadId: p.leadId || null,
    lineId: p.lineId || null,
    userPhone: p.userPhone || null,
    contact: p.contact || {},
    meta: p.meta || {},
    startedAt: FieldValue.serverTimestamp(),
    lastActivityAt: FieldValue.serverTimestamp(),
    messageCount: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    flowRuns: {},
  };
  await ref.set(data);
  await recordStats(p.agentId, { sessions: 1, origin: p.origin, siteKey: p.siteKey, campaignId: p.campaignId, channel: p.channel });
  return { id: ref.id, ...(data as any) };
}

export async function getSession(id: string): Promise<Session | null> {
  const s = await col.sessions().doc(id).get();
  return s.exists ? ({ id: s.id, ...(s.data() as any) } as Session) : null;
}

export interface StoredMessage {
  role: 'user' | 'assistant';
  /** bloques en formato de la API de Claude */
  content: any[];
  /** contenido visible para la UI / reportes */
  display?: { text?: string; ctas?: string[]; media?: Array<{ id: string; url: string; name: string; mimeType?: string }> } | null;
  kind: 'user' | 'assistant' | 'tool_result' | 'tool_use' | 'outbound';
  /** true = solo para mostrar, no se envía al modelo (bienvenida, plantilla inicial) */
  excludeFromModel?: boolean;
  channel?: Channel;
  seq: number;
  createdAt?: any;
}

let seqCounter = 0;
export function nextSeq() {
  seqCounter = (seqCounter + 1) % 1000;
  return Date.now() * 1000 + seqCounter;
}

export async function appendMessages(sessionId: string, msgs: Omit<StoredMessage, 'seq'>[]) {
  const batch = db.batch();
  for (const m of msgs) {
    batch.set(col.messages(sessionId).doc(), { ...m, seq: nextSeq(), createdAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
}

/** Reconstruye el historial para Claude (últimos N mensajes, iniciando en un mensaje de usuario) */
export async function loadHistory(sessionId: string, max = 40): Promise<Array<{ role: 'user' | 'assistant'; content: any[] }>> {
  const snap = await col.messages(sessionId).orderBy('seq', 'desc').limit(max).get();
  const msgs = snap.docs
    .map((d) => d.data() as StoredMessage)
    .reverse()
    .filter((m) => !m.excludeFromModel);
  // Debe comenzar con un mensaje de usuario que no sea tool_result
  while (msgs.length && !(msgs[0].role === 'user' && msgs[0].kind === 'user')) msgs.shift();
  // Fusiona roles consecutivos
  const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = [...last.content, ...m.content];
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}

export async function listDisplayMessages(sessionId: string, limit = 200) {
  const snap = await col.messages(sessionId).orderBy('seq', 'asc').limit(limit).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as any) }))
    .filter((m: any) => m.display && (m.display.text || m.display.media?.length))
    .map((m: any) => ({ id: m.id, role: m.role, kind: m.kind, channel: m.channel, ...m.display, createdAt: m.createdAt }));
}

export async function touchSession(sessionId: string, patch: Record<string, any>, usage?: Usage, cost = 0, messages = 0) {
  await col.sessions().doc(sessionId).update({
    ...patch,
    lastActivityAt: FieldValue.serverTimestamp(),
    ...(messages ? { messageCount: FieldValue.increment(messages) } : {}),
    ...(usage
      ? {
          'usage.input': FieldValue.increment(usage.input),
          'usage.output': FieldValue.increment(usage.output),
          'usage.cacheRead': FieldValue.increment(usage.cacheRead),
          'usage.cacheWrite': FieldValue.increment(usage.cacheWrite),
          costUsd: FieldValue.increment(cost),
        }
      : {}),
  });
}

/** Estadísticas diarias por agente (Dashboard), con desgloses por origen, sitio, canal y campaña */
export async function recordStats(
  agentId: string,
  p: {
    sessions?: number;
    interactions?: number;
    usage?: Usage;
    cost?: number;
    leads?: number;
    origin?: Origin;
    siteKey?: string | null;
    campaignId?: string | null;
    channel?: Channel;
  },
) {
  const inc = FieldValue.increment;
  const tokens = p.usage ? p.usage.input + p.usage.output + p.usage.cacheRead + p.usage.cacheWrite : 0;
  const data: any = { date: dayKey(), updatedAt: FieldValue.serverTimestamp() };
  const add = (prefix: string) => {
    if (p.sessions) data[`${prefix}sessions`] = inc(p.sessions);
    if (p.interactions) data[`${prefix}interactions`] = inc(p.interactions);
    if (tokens) data[`${prefix}tokens`] = inc(tokens);
    if (p.cost) data[`${prefix}costUsd`] = inc(p.cost);
    if (p.leads) data[`${prefix}leads`] = inc(p.leads);
  };
  add('');
  // set+merge no interpreta rutas con punto: se arman objetos anidados
  const nested: any = {};
  const put = (group: string, key: string) => {
    nested[group] = nested[group] || {};
    const o: any = {};
    if (p.sessions) o.sessions = inc(p.sessions);
    if (p.interactions) o.interactions = inc(p.interactions);
    if (tokens) o.tokens = inc(tokens);
    if (p.cost) o.costUsd = inc(p.cost);
    if (p.leads) o.leads = inc(p.leads);
    nested[group][key] = o;
  };
  if (p.origin) put('byOrigin', p.origin);
  if (p.siteKey) put('bySite', p.siteKey);
  if (p.channel) put('byChannel', p.channel);
  if (p.campaignId) put('byCampaign', p.campaignId);
  const out: any = {};
  for (const [k, v] of Object.entries(data)) if (!k.includes('.')) out[k] = v;
  Object.assign(out, nested);
  await col.stats(agentId).doc(dayKey()).set(out, { merge: true });
}
