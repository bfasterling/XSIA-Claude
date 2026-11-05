import { stringify } from 'csv-stringify/sync';
import { col, toDate } from '../lib/firestore.js';
import type { Lead } from '../types.js';

export interface ReportFilters {
  from?: string;
  to?: string;
  type?: string;
  status?: string;
  mood?: string;
  batchId?: string;
}

const SENT_STATES = ['SENT', 'DELIVERED', 'READ', 'REPLIED', 'NO_RESPONSE'];

function inRange(d: Date | null, f: ReportFilters) {
  if (!d) return !f.from && !f.to;
  if (f.from && d < new Date(f.from)) return false;
  if (f.to && d > new Date(f.to + 'T23:59:59')) return false;
  return true;
}

function matches(l: any, f: ReportFilters) {
  if (f.type && l.type !== f.type) return false;
  if (f.status && l.status !== f.status && l.outcome !== f.status) return false;
  if (f.mood && l.evaluation?.mood !== f.mood) return false;
  if (f.batchId && l.batchId !== f.batchId) return false;
  if (f.from || f.to) return inRange(toDate(l.lastSentAt) || toDate(l.importedAt), f);
  return true;
}

/**
 * Indicadores de campaña calculados sobre los leads (con filtros de fecha, tipo, estado y ánimo).
 * Universo: % respuesta y % recuperación/enviados se calculan sobre leads con al menos un envío.
 */
export async function campaignReport(campaignId: string, f: ReportFilters = {}) {
  const snap = await col
    .leads(campaignId)
    .select('type', 'status', 'outcome', 'eligible', 'attempts', 'lastSentAt', 'importedAt', 'repliedAt', 'readAt', 'deliveredAt', 'evaluation', 'crm', 'batchId', 'doNotContact')
    .get();
  const leads = snap.docs.map((d) => d.data()).filter((l) => matches(l, f));
  const k = {
    leads: leads.length,
    eligible: 0,
    pending: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    replied: 0,
    recovered: 0,
    interested: 0,
    notRecovered: 0,
    optOut: 0,
    noResponse: 0,
    activeConversations: 0,
    positive: 0,
    negative: 0,
    neutral: 0,
    undetermined: 0,
    anger: 0,
    complaints: 0,
    crmTransfers: 0,
    crmErrors: 0,
    errors: 0,
    byType: {} as Record<string, any>,
  };
  for (const l of leads) {
    const t = (k.byType[l.type] ||= { leads: 0, sent: 0, replied: 0, recovered: 0 });
    t.leads++;
    if (l.eligible) k.eligible++;
    if (l.status === 'PENDING' && l.eligible) k.pending++;
    const wasSent = SENT_STATES.includes(l.status) || (l.attempts || 0) > 0;
    if (wasSent) {
      k.sent++;
      t.sent++;
    }
    if (l.deliveredAt || ['DELIVERED', 'READ', 'REPLIED'].includes(l.status)) k.delivered++;
    if (l.readAt || ['READ', 'REPLIED'].includes(l.status)) k.read++;
    if (l.repliedAt || l.status === 'REPLIED') {
      k.replied++;
      t.replied++;
      if (!l.outcome || l.outcome === 'INTERESTED') k.activeConversations++;
    }
    if (l.outcome === 'RECOVERED') {
      k.recovered++;
      t.recovered++;
    }
    if (l.outcome === 'INTERESTED') k.interested++;
    if (l.outcome === 'NOT_RECOVERED' || l.outcome === 'NOT_INTERESTED') k.notRecovered++;
    if (l.outcome === 'OPTOUT' || l.evaluation?.optOut) k.optOut++;
    if (l.status === 'NO_RESPONSE') k.noResponse++;
    if (l.status === 'FAILED') k.errors++;
    const mood = l.evaluation?.mood;
    if (mood === 'positive') k.positive++;
    else if (mood === 'negative') k.negative++;
    else if (mood === 'neutral') k.neutral++;
    else if (l.repliedAt) k.undetermined++;
    if (l.evaluation?.anger) k.anger++;
    if (l.evaluation?.complaint || l.outcome === 'COMPLAINT') k.complaints++;
    if (l.crm?.status === 'accepted') k.crmTransfers++;
    if (l.crm?.status === 'error' || l.crm?.status === 'rejected') k.crmErrors++;
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    filters: f,
    kpis: k,
    rates: {
      responseRate: pct(k.replied, k.sent),
      recoveryOverReplied: pct(k.recovered, k.replied),
      recoveryOverSent: pct(k.recovered, k.sent),
      optOutRate: pct(k.optOut, k.sent),
      deliveryRate: pct(k.delivered, k.sent),
      readRate: pct(k.read, k.sent),
    },
    generatedAt: new Date().toISOString(),
  };
}

const iso = (v: any) => toDate(v)?.toISOString() || '';

export async function exportCampaignCsv(campaignId: string): Promise<string> {
  const snap = await col.leads(campaignId).get();
  const rows = snap.docs.map((d) => {
    const l = d.data() as Lead & Record<string, any>;
    return {
      campaign_id: campaignId,
      phone: l.phone,
      source_id: l.sourceId || '',
      first_name: l.firstName || '',
      last_name: l.lastName || '',
      email: l.email || '',
      zip: l.zip || '',
      type: l.type,
      reason: l.reason || '',
      brand: l.brand || '',
      model: l.model || '',
      version: l.version || '',
      year: l.year || '',
      original_dealer_id: l.originalDealerId || '',
      original_dealer_name: l.originalDealerName || '',
      original_date: l.originalDate || '',
      batch: l.batchName || l.batchId,
      imported_at: iso(l.importedAt),
      eligible: l.eligible ? 'SI' : 'NO',
      ineligible_reason: l.ineligibleReason || '',
      status: l.status,
      outcome: l.outcome || '',
      attempts: l.attempts || 0,
      line_id: l.lineId || '',
      last_sent_at: iso(l.lastSentAt),
      delivered_at: iso(l.deliveredAt),
      read_at: iso(l.readAt),
      replied_at: iso(l.repliedAt),
      last_error: l.lastError ? `${l.lastError.code || ''} ${l.lastError.message || ''}`.trim() : '',
      mood: l.evaluation?.mood || '',
      purchase_intent: l.evaluation?.purchaseIntent || '',
      recovery_probability: l.evaluation?.recoveryProbability ?? '',
      complaint: l.evaluation?.complaint ? 'SI' : '',
      selected_dealer_id: l.selectedDealer?.id || '',
      selected_dealer_name: l.selectedDealer?.name || '',
      crm_status: l.crm?.status || '',
      crm_external_id: l.crm?.externalId || '',
      crm_error: l.crm?.error || '',
      session_id: l.sessionId || '',
    };
  });
  return '﻿' + stringify(rows, { header: true });
}
