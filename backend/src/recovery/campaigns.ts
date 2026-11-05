import { col, db, FieldValue } from '../lib/firestore.js';
import { conflict, badRequest, notFound } from '../lib/http.js';
import { normalizeSearch, renderTemplate, dayKey } from '../lib/utils.js';
import { withDefaults, getAgent } from '../chat/agents.js';
import { config } from '../config.js';
import type { Campaign, Lead, LeadType, TemplateConfig, WaLine } from '../types.js';
import { LEAD_TYPES } from '../types.js';

const tpl = (crmOrigin: string, label: string): TemplateConfig => ({
  name: '',
  language: 'es_MX',
  params: ['firstName', 'brand', 'model', 'promotion'],
  previewText: '',
  context: '',
  crmOrigin,
  originDescription: `Campaña de Reasignación - ${label}`,
  enabled: true,
});

export const CAMPAIGN_DEFAULTS: Omit<Campaign, 'id' | 'name'> = {
  description: '',
  status: 'draft',
  agentId: '',
  actionFlowId: '',
  agentInstructions: '',
  templates: {
    NOT_CONTACTED: tpl('NOT_CONTACTED', 'No contactado'),
    ABANDONED: tpl('ABANDONED', 'Abandonado'),
    REJECTED: tpl('REJECTED', 'Rechazado'),
  },
  secondAttemptTemplates: {},
  promotions: { rules: [], defaultText: '' },
  whatsapp: {
    lineIds: [],
    strategy: 'balanced',
    weights: {},
    specificLineId: '',
    window: { startHour: 9, endHour: 19, days: [1, 2, 3, 4, 5, 6], timezone: config.defaultTimezone },
    maxPerHour: 200,
    maxConcurrent: 10,
  },
  rules: { noResponseHours: 48, markNoResponse: true, secondAttempt: false, secondAttemptDelayHours: 24 },
  crm: {
    mode: 'webhook',
    url: '',
    method: 'POST',
    headers: {},
    payloadTemplate: '',
    responseIdPath: '',
    excludeOriginalDealer: true,
    dealerCount: 3,
    customerServiceMessage: '',
    customerServicePhone: '',
    customerServiceEmail: '',
  },
  evaluation: { mood: true, purchaseIntent: true, recoveryProbability: true, complaint: true, optOut: true },
  currentExecutionId: null,
};

export async function getCampaign(id: string): Promise<Campaign> {
  const s = await col.campaign(id).get();
  if (!s.exists) throw notFound('Campaña no encontrada');
  const c = withDefaults(CAMPAIGN_DEFAULTS as any, s.data()) as Campaign;
  c.id = s.id;
  return c;
}

/** Promoción más específica que coincide con el vehículo del lead */
export function resolvePromotion(c: Campaign, lead: Partial<Lead>): string {
  let best: { score: number; text: string } | null = null;
  for (const r of c.promotions?.rules || []) {
    let score = 0;
    let ok = true;
    for (const k of ['brand', 'model', 'version', 'year'] as const) {
      const rv = (r as any)[k];
      if (!rv) continue;
      if (normalizeSearch(String(lead[k] || '')) === normalizeSearch(String(rv))) score++;
      else ok = false;
    }
    if (ok && (!best || score > best.score)) best = { score, text: r.text };
  }
  return best?.text || c.promotions?.defaultText || '';
}

export function templateFor(c: Campaign, lead: Lead, attemptNumber: number): TemplateConfig | null {
  const second = attemptNumber >= 2 ? c.secondAttemptTemplates?.[lead.type] : null;
  if (second?.name) return second as TemplateConfig;
  const t = c.templates?.[lead.type];
  return t?.name && t.enabled !== false ? t : null;
}

export function templateParams(c: Campaign, t: TemplateConfig, lead: Lead): string[] {
  const values: Record<string, string> = {
    firstName: lead.firstName || 'cliente',
    lastName: lead.lastName || '',
    fullName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'cliente',
    brand: lead.brand || '',
    model: lead.model || '',
    version: lead.version || '',
    year: lead.year || '',
    promotion: resolvePromotion(c, lead),
    dealerName: lead.originalDealerName || '',
    vehicle: [lead.brand, lead.model, lead.version].filter(Boolean).join(' '),
  };
  return (t.params || []).map((k) => (k.startsWith('"') ? k.replace(/"/g, '') : values[k] ?? ''));
}

export function previewTemplate(t: TemplateConfig, params: string[]) {
  if (!t.previewText) return `[Plantilla ${t.name}] ${params.filter(Boolean).join(' · ')}`;
  return t.previewText.replace(/\{\{(\d+)\}\}/g, (_m, n) => params[Number(n) - 1] ?? '');
}

export async function usableLines(c: Campaign): Promise<WaLine[]> {
  const ids = c.whatsapp?.lineIds || [];
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => col.waLines().doc(id)));
  return snaps
    .filter((s) => s.exists)
    .map((s) => ({ id: s.id, ...(s.data() as any) }) as WaLine)
    .filter((l) => l.enabled && l.phoneNumberId && l.accessToken);
}

export interface Check {
  key: string;
  label: string;
  ok: boolean;
  severity: 'error' | 'warning';
  detail?: string;
}

/** Prevalidación: condiciones mínimas para lanzar (no garantiza aceptación del canal) */
export async function prevalidate(campaignId: string): Promise<{ ok: boolean; checks: Check[] }> {
  const c = await getCampaign(campaignId);
  const checks: Check[] = [];
  const add = (key: string, label: string, ok: boolean, detail?: string, severity: 'error' | 'warning' = 'error') =>
    checks.push({ key, label, ok, detail, severity });

  add('status', 'Campaña en estado que permite iniciar', ['draft', 'paused', 'cancelled', 'completed'].includes(c.status), `Estado: ${c.status}`);
  const agent = c.agentId ? await getAgent(c.agentId) : null;
  add('agent', 'Agente XSIA asignado y activo', !!agent && agent.status !== 'inactive', agent ? agent.name : 'Sin agente');
  if (c.actionFlowId) {
    const flow = agent?.actionFlows?.find((f) => f.id === c.actionFlowId);
    add('flow', 'Flujo de acción de CRM habilitado', !!flow?.enabled, flow?.name || 'No encontrado');
  }

  const eligibleSnap = await col.leads(campaignId).where('eligible', '==', true).where('status', '==', 'PENDING').count().get();
  const eligible = eligibleSnap.data().count;
  add('leads', 'Leads elegibles pendientes de envío', eligible > 0, `${eligible} leads`);

  const lines = await usableLines(c);
  const selected = c.whatsapp?.lineIds?.length || 0;
  add('lines', 'Al menos una línea seleccionada habilitada y apta', lines.length > 0, `${lines.length} de ${selected} seleccionadas están habilitadas`);
  if (lines.length < selected)
    add('lines_disabled', 'Líneas deshabilitadas en la selección', true, `${selected - lines.length} se omitirán (no bloquean el inicio)`, 'warning');
  if (c.whatsapp.strategy === 'specific')
    add('specific_line', 'Línea específica habilitada', lines.some((l) => l.id === c.whatsapp.specificLineId), c.whatsapp.specificLineId || 'Sin línea');

  const w = c.whatsapp.window;
  add('window', 'Ventana horaria coherente', w.startHour < w.endHour && w.days.length > 0, `${w.startHour}:00–${w.endHour}:00, días ${w.days.join(',')}`);
  add('capacity', 'Límites de capacidad coherentes', c.whatsapp.maxPerHour > 0 && c.whatsapp.maxConcurrent > 0, `${c.whatsapp.maxPerHour}/h, ${c.whatsapp.maxConcurrent} concurrentes`);
  const day = dayKey();
  let capacity = 0;
  for (const l of lines) {
    const used = ((await col.lineUsage().doc(`${l.id}_${day}`).get()).data() as any)?.count || 0;
    capacity += Math.max(0, (l.dailyLimit || 250) - used);
  }
  add('line_capacity', 'Capacidad diaria disponible en líneas', capacity > 0, `${capacity} envíos disponibles hoy`, capacity > 0 ? 'warning' : 'error');

  // Plantillas para los tipos presentes
  for (const t of LEAD_TYPES) {
    const n = (await col.leads(campaignId).where('type', '==', t).where('eligible', '==', true).where('status', '==', 'PENDING').count().get()).data().count;
    if (!n) continue;
    const tc = c.templates?.[t];
    add(`template_${t}`, `Plantilla configurada para ${t}`, !!tc?.name && !!tc?.language, tc?.name ? `${tc.name} (${tc.language}) · ${n} leads` : `Falta plantilla · ${n} leads`);
    if (tc?.params?.includes('promotion') && !c.promotions?.defaultText && !c.promotions?.rules?.length)
      add(`promo_${t}`, `Promoción para ${t}`, false, 'La plantilla usa promoción pero no hay reglas ni texto predeterminado', 'warning');
  }
  add('crm', 'Destino CRM configurado', c.crm.mode === 'none' || (c.crm.mode === 'webhook' ? !!c.crm.url : !!c.actionFlowId), c.crm.mode, 'warning');
  if (c.rules.secondAttempt) add('second', 'Segundo intento habilitado', true, `Tras ${c.rules.noResponseHours}h sin respuesta`, 'warning');

  return { ok: checks.every((x) => x.ok || x.severity === 'warning'), checks };
}

export async function startCampaign(id: string, user: string) {
  const v = await prevalidate(id);
  if (!v.ok) throw badRequest('La prevalidación no se cumplió', v.checks.filter((c) => !c.ok));
  const exec = col.executions(id).doc();
  await exec.set({ status: 'running', startedAt: FieldValue.serverTimestamp(), startedBy: user });
  await col.campaign(id).update({ status: 'running', currentExecutionId: exec.id, updatedAt: FieldValue.serverTimestamp() });
  return { executionId: exec.id, checks: v.checks };
}

export async function pauseCampaign(id: string, user: string) {
  const c = await getCampaign(id);
  if (c.status !== 'running') throw conflict('Solo se puede pausar una campaña en ejecución');
  await col.campaign(id).update({ status: 'paused', updatedAt: FieldValue.serverTimestamp() });
  if (c.currentExecutionId) await col.executions(id).doc(c.currentExecutionId).update({ status: 'paused', pausedAt: FieldValue.serverTimestamp(), pausedBy: user });
}

export async function resumeCampaign(id: string, user: string) {
  const c = await getCampaign(id);
  if (c.status !== 'paused') throw conflict('Solo se puede reanudar una campaña en pausa');
  const lines = await usableLines(c);
  if (!lines.length) throw badRequest('No hay líneas habilitadas en la selección de la campaña');
  await col.campaign(id).update({ status: 'running', updatedAt: FieldValue.serverTimestamp() });
  if (c.currentExecutionId) await col.executions(id).doc(c.currentExecutionId).update({ status: 'running', resumedAt: FieldValue.serverTimestamp(), resumedBy: user });
}

/** Cancela la ejecución: libera reservas de intentos no enviados. No borra campaña ni historial. */
export async function cancelExecution(id: string, user: string) {
  const c = await getCampaign(id);
  if (!['running', 'paused'].includes(c.status)) throw conflict('No hay ejecución activa');
  await col.campaign(id).update({ status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
  if (c.currentExecutionId)
    await col.executions(id).doc(c.currentExecutionId).update({ status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), cancelledBy: user });
  const scheduled = await col.leads(id).where('status', '==', 'SCHEDULED').get();
  const w = db.bulkWriter();
  scheduled.docs.forEach((d) => w.update(d.ref, { status: 'PENDING', releasedAt: FieldValue.serverTimestamp() }));
  await w.close();
  return { released: scheduled.size };
}

export async function retryLead(campaignId: string, leadId: string) {
  const ref = col.leads(campaignId).doc(leadId);
  const s = await ref.get();
  if (!s.exists) throw notFound('Lead no encontrado');
  const l = s.data() as Lead;
  if (!['FAILED', 'CANCELLED'].includes(l.status)) throw conflict('Solo se reintentan envíos fallidos o cancelados');
  if (!l.eligible) throw conflict('El lead no es elegible');
  if ((await col.suppressions().doc(l.phone).get()).data()?.active) throw conflict('El teléfono está en lista de supresión');
  await ref.update({ status: 'PENDING', nextAttemptAt: FieldValue.serverTimestamp(), retriedAt: FieldValue.serverTimestamp() });
}

export async function duplicateCampaign(id: string, user: string) {
  const c = await getCampaign(id);
  const { id: _i, currentExecutionId: _e, createdAt: _c, updatedAt: _u, ...rest } = c as any;
  const ref = col.campaigns().doc();
  await ref.set({
    ...rest,
    name: `${c.name} (copia)`,
    status: 'draft',
    currentExecutionId: null,
    counters: {},
    createdBy: user,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function deleteCampaign(id: string) {
  const c = await getCampaign(id);
  if (c.status === 'running') throw conflict('No se puede eliminar una campaña en ejecución. Páusala o cancélala primero.');
  await db.recursiveDelete(col.campaign(id));
}

export { renderTemplate, type LeadType };
