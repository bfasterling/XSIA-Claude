import { col, db, FieldValue, Timestamp } from '../lib/firestore.js';
import { config } from '../config.js';
import { dayKey, zonedParts } from '../lib/utils.js';
import { enqueue } from '../lib/tasks.js';
import { logger } from '../lib/logger.js';
import { sendTemplate } from '../channels/whatsapp.js';
import { getCampaign, previewTemplate, templateFor, templateParams, usableLines } from './campaigns.js';
import { suppressedSet, isSuppressed } from './suppression.js';
import type { Campaign, Lead, WaLine } from '../types.js';

/**
 * Programador de Recovery (Cloud Scheduler → /tasks/recovery-tick cada minuto):
 *  1. Marca "Sin respuesta" y programa segundos intentos.
 *  2. Dentro de la ventana, reserva leads elegibles respetando límites por hora,
 *     concurrencia y límite diario por línea; los encola en Cloud Tasks.
 */
export async function recoveryTickTask() {
  const running = await col.campaigns().where('status', '==', 'running').get();
  for (const d of running.docs) {
    try {
      const c = await getCampaign(d.id);
      await processNoResponse(c);
      await scheduleBatch(c);
    } catch (e) {
      logger.error('Tick de campaña falló', { campaignId: d.id, error: e });
    }
  }
  return { campaigns: running.size };
}

async function processNoResponse(c: Campaign) {
  const hours = c.rules?.noResponseHours || 0;
  if (!hours) return;
  const cutoff = Timestamp.fromMillis(Date.now() - hours * 3600_000);
  const snap = await col
    .leads(c.id)
    .where('status', 'in', ['SENT', 'DELIVERED', 'READ'])
    .where('lastSentAt', '<=', cutoff)
    .limit(500)
    .get();
  if (snap.empty) return;
  const w = db.bulkWriter();
  let noResp = 0;
  for (const doc of snap.docs) {
    const l = doc.data() as Lead;
    if (l.repliedAt || l.outcome) continue;
    const canRetry = c.rules.secondAttempt && (l.attempts || 0) < 2 && l.eligible && !l.doNotContact;
    if (canRetry) {
      w.update(doc.ref, {
        status: 'PENDING',
        nextAttemptAt: Timestamp.fromMillis(Date.now() + (c.rules.secondAttemptDelayHours || 0) * 3600_000),
        firstNoResponseAt: FieldValue.serverTimestamp(),
      });
    } else if (c.rules.markNoResponse) {
      w.update(doc.ref, { status: 'NO_RESPONSE', noResponseAt: FieldValue.serverTimestamp() });
      noResp++;
    }
  }
  await w.close();
  if (noResp) await col.campaign(c.id).update({ 'counters.noResponse': FieldValue.increment(noResp) });
}

function inWindow(c: Campaign, now = new Date()) {
  const w = c.whatsapp.window;
  const { hour, day } = zonedParts(now, w.timezone || config.defaultTimezone);
  return w.days.includes(day) && hour >= w.startHour && hour < w.endHour;
}

function pickLine(c: Campaign, lines: Array<WaLine & { available: number; usedToday: number }>, rr: number) {
  const avail = lines.filter((l) => l.available > 0);
  if (!avail.length) return null;
  if (c.whatsapp.strategy === 'specific') return avail.find((l) => l.id === c.whatsapp.specificLineId) || null;
  if (c.whatsapp.strategy === 'weighted') {
    const total = avail.reduce((s, l) => s + (c.whatsapp.weights?.[l.id] ?? 1), 0);
    let r = Math.random() * total;
    for (const l of avail) {
      r -= c.whatsapp.weights?.[l.id] ?? 1;
      if (r <= 0) return l;
    }
    return avail[avail.length - 1];
  }
  // balanceada: la línea con menor uso del día (desempate round-robin)
  return [...avail].sort((a, b) => a.usedToday - b.usedToday || ((a.id > b.id ? 1 : -1) * (rr % 2 ? 1 : -1)))[0];
}

async function scheduleBatch(c: Campaign) {
  if (!inWindow(c)) return;
  const lines = await usableLines(c);
  if (!lines.length) {
    await col.campaign(c.id).update({ lastTickNote: 'Sin líneas habilitadas', lastTickAt: FieldValue.serverTimestamp() });
    return;
  }
  const day = dayKey();
  const lineState = await Promise.all(
    lines.map(async (l) => {
      const used = ((await col.lineUsage().doc(`${l.id}_${day}`).get()).data() as any)?.count || 0;
      return { ...l, usedToday: used, available: Math.max(0, (l.dailyLimit || 250) - used) };
    }),
  );
  const lineCapacity = lineState.reduce((s, l) => s + l.available, 0);

  const hourAgo = Timestamp.fromMillis(Date.now() - 3600_000);
  const sentLastHour = (await col.attempts(c.id).where('createdAt', '>=', hourAgo).count().get()).data().count;
  const inflight = (await col.leads(c.id).where('status', 'in', ['SCHEDULED', 'SENDING']).count().get()).data().count;
  const budget = Math.min(
    c.whatsapp.maxPerHour - sentLastHour,
    c.whatsapp.maxConcurrent - inflight,
    Math.ceil(c.whatsapp.maxPerHour / 60) * 2, // suaviza el ritmo por minuto
    lineCapacity,
    200,
  );
  if (budget <= 0) return;

  const snap = await col
    .leads(c.id)
    .where('eligible', '==', true)
    .where('status', '==', 'PENDING')
    .where('nextAttemptAt', '<=', Timestamp.now())
    .orderBy('nextAttemptAt', 'asc')
    .limit(budget)
    .get();
  if (snap.empty) {
    // ¿Ya no queda nada por enviar? La campaña sigue activa para atender respuestas.
    await col.campaign(c.id).update({ lastTickNote: 'Sin leads pendientes', lastTickAt: FieldValue.serverTimestamp() });
    return;
  }
  const leads = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }) as Lead);
  const suppressed = await suppressedSet(leads.map((l) => l.phone));

  let i = 0;
  for (const lead of leads) {
    if (suppressed.has(lead.phone)) {
      await col.leads(c.id).doc(lead.id).update({ eligible: false, ineligibleReason: 'SUPPRESSED' });
      continue;
    }
    const line = pickLine(c, lineState, i);
    if (!line) break;
    const attemptRef = col.attempts(c.id).doc();
    const reserved = await db.runTransaction(async (tx) => {
      const ls = await tx.get(col.leads(c.id).doc(lead.id));
      const cur = ls.data() as Lead;
      if (!cur || cur.status !== 'PENDING' || !cur.eligible) return false;
      tx.update(ls.ref, { status: 'SCHEDULED', lastAttemptId: attemptRef.id, lineId: line.id, executionId: c.currentExecutionId || null });
      tx.set(col.lineUsage().doc(`${line.id}_${day}`), { count: FieldValue.increment(1), lineId: line.id, day }, { merge: true });
      tx.set(attemptRef, {
        campaignId: c.id,
        leadId: lead.id,
        executionId: c.currentExecutionId || null,
        lineId: line.id,
        phoneNumberId: line.phoneNumberId,
        attemptNumber: (cur.attempts || 0) + 1,
        status: 'SCHEDULED',
        scheduledAt: Timestamp.fromMillis(Date.now() + Math.floor((i / Math.max(1, leads.length)) * 55_000)),
        createdAt: FieldValue.serverTimestamp(),
        statusHistory: [],
      });
      return true;
    });
    if (!reserved) continue;
    line.available--;
    line.usedToday++;
    await enqueue(
      'recovery-send',
      { campaignId: c.id, attemptId: attemptRef.id },
      { queue: config.tasks.queueSend, scheduleAt: new Date(Date.now() + Math.floor((i / Math.max(1, leads.length)) * 55_000)), dedupeId: `send-${attemptRef.id}` },
    );
    i++;
  }
  await col.campaign(c.id).update({ lastTickNote: `${i} envíos programados`, lastTickAt: FieldValue.serverTimestamp() });
}

async function releaseLineUsage(lineId: string) {
  await col
    .lineUsage()
    .doc(`${lineId}_${dayKey()}`)
    .set({ count: FieldValue.increment(-1) }, { merge: true });
}

/** Envía una plantilla (tarea individual por intento) */
export async function recoverySendTask(p: { campaignId: string; attemptId: string }) {
  const attemptRef = col.attempts(p.campaignId).doc(p.attemptId);
  const attempt: any = (await attemptRef.get()).data();
  if (!attempt || attempt.status !== 'SCHEDULED') return;
  const c = await getCampaign(p.campaignId);
  const leadRef = col.leads(p.campaignId).doc(attempt.leadId);

  const hold = async (reason: string, leadStatus: 'PENDING' | 'CANCELLED') => {
    await attemptRef.update({ status: 'CANCELLED', cancelReason: reason, finishedAt: FieldValue.serverTimestamp() });
    await leadRef.update({ status: leadStatus });
    await releaseLineUsage(attempt.lineId);
  };

  // Pausa o cancelación: el intento no enviado se libera y el lead vuelve a pendiente
  if (c.status !== 'running') return hold(c.status === 'paused' ? 'Campaña en pausa' : 'Ejecución cancelada', 'PENDING');
  const lead = { id: attempt.leadId, ...((await leadRef.get()).data() as any) } as Lead;
  if (!lead.eligible || lead.doNotContact) return hold('Lead no elegible', 'CANCELLED');
  if (await isSuppressed(lead.phone)) {
    await leadRef.update({ eligible: false, ineligibleReason: 'SUPPRESSED' });
    return hold('Teléfono suprimido', 'CANCELLED');
  }
  const lines = await usableLines(c);
  const line = lines.find((l) => l.id === attempt.lineId) || lines[0];
  if (!line) return hold('Sin líneas habilitadas', 'PENDING');

  const template = templateFor(c, lead, attempt.attemptNumber);
  if (!template) {
    await attemptRef.update({ status: 'FAILED', error: { message: `Sin plantilla configurada para ${lead.type}` }, finishedAt: FieldValue.serverTimestamp() });
    await leadRef.update({ status: 'FAILED', lastError: { message: 'Sin plantilla' } });
    await releaseLineUsage(attempt.lineId);
    return;
  }
  const params = templateParams(c, template, lead);

  // Paso a SENDING de forma atómica (evita doble envío si la tarea se reintenta)
  const ok = await db.runTransaction(async (tx) => {
    const ls = await tx.get(leadRef);
    const cur = ls.data() as Lead;
    if (cur.lastAttemptId !== p.attemptId || cur.status !== 'SCHEDULED') return false;
    tx.update(leadRef, { status: 'SENDING' });
    tx.update(attemptRef, {
      status: 'SENDING',
      startedAt: FieldValue.serverTimestamp(),
      lineId: line.id,
      phoneNumberId: line.phoneNumberId,
      template: template.name,
      language: template.language,
      params,
    });
    return true;
  });
  if (!ok) return;

  const res = await sendTemplate(line, lead.phone, template.name, template.language, params, template.headerImageUrl);
  if (res.ok) {
    const text = previewTemplate(template, params);
    await attemptRef.update({
      status: 'SENT',
      channelStatus: 'ACCEPTED',
      waMessageId: res.messageId || null,
      finishedAt: FieldValue.serverTimestamp(),
      response: { httpStatus: res.httpStatus },
    });
    if (res.messageId)
      await col.waMessages().doc(res.messageId).set({ campaignId: c.id, leadId: lead.id, attemptId: p.attemptId, at: FieldValue.serverTimestamp() });
    await leadRef.update({
      status: 'SENT',
      attempts: FieldValue.increment(1),
      lastSentAt: FieldValue.serverTimestamp(),
      lineId: line.id,
      lastError: null,
    });
    // Enrutamiento de la respuesta entrante hacia esta campaña/lead/agente
    await col.waContacts().doc(`${line.id}_${lead.phone}`).set(
      {
        campaignId: c.id,
        leadId: lead.id,
        agentId: c.agentId,
        templateName: template.name,
        templateText: text,
        sessionId: lead.sessionId || null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await col.campaign(c.id).update({ 'counters.sent': FieldValue.increment(1) });
  } else {
    await attemptRef.update({
      status: 'FAILED',
      error: res.error || { message: 'Error desconocido' },
      response: { httpStatus: res.httpStatus },
      finishedAt: FieldValue.serverTimestamp(),
    });
    await leadRef.update({ status: 'FAILED', lastError: res.error || null });
    await col.campaign(c.id).update({ 'counters.failed': FieldValue.increment(1) });
    await releaseLineUsage(line.id);
    logger.warn('Envío de plantilla falló', { campaignId: c.id, leadId: lead.id, error: res.error });
  }
}
