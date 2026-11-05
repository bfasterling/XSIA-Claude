import { col, FieldValue } from '../lib/firestore.js';
import { structured } from '../lib/claude.js';
import { listDisplayMessages } from '../chat/sessions.js';
import { suppress } from './suppression.js';
import { getCampaign } from './campaigns.js';
import type { Lead } from '../types.js';

/**
 * Evaluación conversacional complementaria con Claude: ánimo, intención de compra,
 * probabilidad de recuperación, queja y opt-out. Son señales, no sustituyen la voluntad expresa.
 */
export async function evaluateTask(p: { campaignId: string; leadId: string; sessionId: string }) {
  const c = await getCampaign(p.campaignId);
  const ev = c.evaluation || ({} as any);
  if (!Object.values(ev).some(Boolean)) return;
  const msgs = await listDisplayMessages(p.sessionId, 80);
  if (!msgs.some((m: any) => m.role === 'user')) return;
  const transcript = msgs.map((m: any) => `${m.role === 'user' ? 'CLIENTE' : 'ASESOR'}: ${m.text || ''}`).join('\n');

  const { data } = await structured<any>({
    system: 'Eres un analista de calidad de conversaciones comerciales. Evalúas con objetividad; si no hay evidencia suficiente usa "undetermined"/"none".',
    prompt: `Analiza esta conversación de reactivación de un lead (WhatsApp):\n\n${transcript}\n\nEvalúa la postura del CLIENTE.`,
    schema: {
      type: 'object',
      properties: {
        mood: { type: 'string', enum: ['positive', 'neutral', 'negative', 'undetermined'] },
        anger: { type: 'boolean', description: 'Señales de enojo o molestia' },
        purchaseIntent: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
        recoveryProbability: { type: 'number', description: '0 a 1' },
        complaint: { type: 'boolean' },
        optOut: { type: 'boolean', description: 'El cliente pidió explícitamente no recibir más mensajes' },
        rationale: { type: 'string', description: 'Justificación breve' },
      },
      required: ['mood', 'anger', 'purchaseIntent', 'recoveryProbability', 'complaint', 'optOut'],
    },
    name: 'evaluacion',
  });

  const evaluation: Record<string, any> = { updatedAt: FieldValue.serverTimestamp(), rationale: data.rationale || '' };
  if (ev.mood) {
    evaluation.mood = data.mood;
    evaluation.anger = !!data.anger;
  }
  if (ev.purchaseIntent) evaluation.purchaseIntent = data.purchaseIntent;
  if (ev.recoveryProbability) evaluation.recoveryProbability = Math.max(0, Math.min(1, Number(data.recoveryProbability) || 0));
  if (ev.complaint) evaluation.complaint = !!data.complaint;
  if (ev.optOut) evaluation.optOut = !!data.optOut;

  const leadRef = col.leads(p.campaignId).doc(p.leadId);
  await leadRef.update({ evaluation });
  if (ev.optOut && data.optOut) {
    const lead = (await leadRef.get()).data() as Lead;
    await suppress(lead.phone, 'Opt-out detectado en evaluación', `campaign:${p.campaignId}`);
    await leadRef.update({
      doNotContact: true,
      eligible: false,
      ineligibleReason: 'OPTOUT',
      ...(lead.outcome !== 'RECOVERED' ? { outcome: 'OPTOUT' } : {}),
    });
  }
}
