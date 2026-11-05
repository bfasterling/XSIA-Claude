import { col, db, FieldValue } from '../lib/firestore.js';
import { fetchWithTimeout, readBody } from '../lib/http.js';
import { getPath, renderTemplate, truncate } from '../lib/utils.js';
import { logger } from '../lib/logger.js';
import type { ActionFlow, Agent, Campaign, Lead, Session } from '../types.js';

/**
 * Ejecución de una petición a un receptor externo (CRM / flujo de acción),
 * preservando las etapas: preparada → enviada → respuesta → aceptada/rechazada.
 */
export async function postToReceiver(p: {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  payloadTemplate?: string;
  vars: Record<string, any>;
  responseIdPath?: string;
  log: Record<string, any>;
}) {
  const logRef = col.actionLogs().doc();
  let payload: any;
  try {
    payload = p.payloadTemplate?.trim() ? JSON.parse(renderTemplate(p.payloadTemplate, p.vars, true)) : p.vars;
  } catch (e: any) {
    await logRef.set({ ...p.log, stage: 'prepared', status: 'error', error: 'Plantilla de payload inválida: ' + e.message, at: FieldValue.serverTimestamp() });
    return { accepted: false, stage: 'prepared', error: 'Configuración de payload inválida' };
  }
  await logRef.set({ ...p.log, url: p.url, stage: 'prepared', payload, at: FieldValue.serverTimestamp() });
  let res: Response;
  try {
    await logRef.update({ stage: 'sent', sentAt: FieldValue.serverTimestamp() });
    res = await fetchWithTimeout(renderTemplate(p.url, p.vars), {
      method: p.method || 'POST',
      headers: { 'Content-Type': 'application/json', ...(p.headers || {}) },
      body: JSON.stringify(payload),
      timeoutMs: 20000,
    });
  } catch (e: any) {
    await logRef.update({ stage: 'sent', status: 'error', error: String(e?.message || e) });
    return { accepted: false, stage: 'sent', error: 'No se obtuvo respuesta del sistema destino' };
  }
  const body = await readBody(res);
  const externalId = p.responseIdPath ? getPath(body, p.responseIdPath) : getPath(body, 'id') ?? getPath(body, 'data.id');
  const accepted = res.ok && (!p.responseIdPath || (externalId !== undefined && externalId !== null && externalId !== ''));
  await logRef.update({
    stage: accepted ? 'accepted' : 'rejected',
    httpStatus: res.status,
    response: truncate(typeof body === 'string' ? body : JSON.stringify(body), 5000),
    externalId: externalId ?? null,
    respondedAt: FieldValue.serverTimestamp(),
  });
  return {
    accepted,
    stage: accepted ? 'accepted' : 'rejected',
    httpStatus: res.status,
    externalId: externalId ?? null,
    error: accepted ? undefined : truncate(typeof body === 'string' ? body : JSON.stringify(body), 400),
    logId: logRef.id,
  };
}

/**
 * Transferencia de un lead recuperado al CRM con prevención de duplicados:
 * si el lead ya tiene crm.status = accepted o hay una transferencia en curso, no se repite.
 */
export async function transferRecoveredLead(p: {
  campaign: Campaign;
  lead: Lead;
  agent: Agent;
  session: Session;
  dealer: { id: string; name: string };
}) {
  const { campaign, agent, session, dealer } = p;
  const leadRef = col.leads(campaign.id).doc(p.lead.id);

  const claim = await db.runTransaction(async (tx) => {
    const s = await tx.get(leadRef);
    const l = s.data() as Lead;
    if (l.crm?.status === 'accepted') return { already: true, crm: l.crm };
    if (l.crm?.status === 'pending' && l.crm.attemptedAt && Date.now() - l.crm.attemptedAt.toMillis() < 60_000)
      return { already: true, inProgress: true, crm: l.crm };
    tx.update(leadRef, {
      selectedDealer: dealer,
      crm: { status: 'pending', attemptedAt: FieldValue.serverTimestamp() },
    });
    return { already: false };
  });
  if (claim.already) {
    return { accepted: claim.crm?.status === 'accepted', duplicate: true, externalId: (claim.crm as any)?.externalId, message: 'La oportunidad ya fue registrada previamente; no se duplicó.' };
  }

  const lead = p.lead;
  const tpl = campaign.templates?.[lead.type];
  const vars = {
    lead: { ...lead, fullName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') },
    dealer,
    campaign: { id: campaign.id, name: campaign.name },
    origin: tpl?.crmOrigin || lead.type,
    originDescription: tpl?.originDescription || `Campaña de Reasignación - ${lead.type}`,
    session: { id: session.id },
    contact: session.contact || {},
  };

  let result: any;
  if (campaign.crm?.mode === 'action_flow' && campaign.actionFlowId) {
    const flow = (agent.actionFlows || []).find((f) => f.id === campaign.actionFlowId);
    if (!flow) result = { accepted: false, error: 'Flujo de acción de la campaña no encontrado' };
    else
      result = await postToReceiver({
        url: flow.url,
        method: flow.method,
        headers: flow.headers,
        payloadTemplate: flow.payloadTemplate,
        responseIdPath: flow.responseIdPath,
        vars: { ...vars, ...flattenLeadVars(vars) },
        log: { kind: 'recovery_crm', campaignId: campaign.id, leadId: lead.id, sessionId: session.id, flowId: flow.id },
      });
  } else if (campaign.crm?.mode === 'webhook' && campaign.crm.url) {
    result = await postToReceiver({
      url: campaign.crm.url,
      method: campaign.crm.method,
      headers: campaign.crm.headers,
      payloadTemplate: campaign.crm.payloadTemplate,
      responseIdPath: campaign.crm.responseIdPath,
      vars,
      log: { kind: 'recovery_crm', campaignId: campaign.id, leadId: lead.id, sessionId: session.id },
    });
  } else {
    result = { accepted: false, error: 'La campaña no tiene destino CRM configurado' };
  }

  await leadRef.update({
    crm: {
      status: result.accepted ? 'accepted' : 'error',
      externalId: result.externalId ?? null,
      error: result.error ?? null,
      httpStatus: result.httpStatus ?? null,
      attemptedAt: FieldValue.serverTimestamp(),
    },
    ...(result.accepted ? { outcome: 'RECOVERED', recoveredAt: FieldValue.serverTimestamp() } : {}),
  });
  if (result.accepted) {
    await col.campaign(campaign.id).update({ 'counters.recovered': FieldValue.increment(1), 'counters.crmTransfers': FieldValue.increment(1) });
  }
  logger.info('Transferencia CRM Recovery', { campaignId: campaign.id, leadId: lead.id, accepted: result.accepted });
  return result;
}

function flattenLeadVars(v: any) {
  return {
    name: v.lead.firstName,
    lastName: v.lead.lastName,
    phone: v.lead.phone,
    email: v.lead.email,
    brand: v.lead.brand,
    model: v.lead.model,
    version: v.lead.version,
    year: v.lead.year,
    dealerId: v.dealer.id,
    dealerName: v.dealer.name,
  };
}

export type { ActionFlow };
