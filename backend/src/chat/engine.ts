import { claude, addUsage, costUsd, emptyUsage, type Usage } from '../lib/claude.js';
import { config } from '../config.js';
import { col } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { buildSystemPrompt, type RecoveryContext } from './prompt.js';
import { buildTools, runTool, type ToolContext } from './tools.js';
import { appendMessages, loadHistory, recordStats, touchSession, type StoredMessage } from './sessions.js';
import { activeMedia } from '../rag/media.js';
import type { Agent, Channel, Session, Site } from '../types.js';

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; status: 'start' | 'end' }
  | { type: 'media'; item: { id: string; url: string; name: string; mimeType?: string } }
  | { type: 'ctas'; ctas: string[] }
  | { type: 'done'; text: string; ctas: string[]; media: any[]; followUps: string[] }
  | { type: 'error'; message: string };

export interface TurnResult {
  text: string;
  ctas: string[];
  media: Array<{ id: string; url: string; name: string; mimeType?: string }>;
  followUps: string[];
  usage: Usage;
  costUsd: number;
}

const CTA_RE = /<ctas>([\s\S]*?)<\/ctas>/i;

export function splitCtas(text: string): { text: string; ctas: string[] } {
  const m = text.match(CTA_RE);
  if (!m) return { text: text.replace(/<ctas>[\s\S]*$/i, '').trim(), ctas: [] };
  let ctas: string[] = [];
  try {
    ctas = JSON.parse(m[1]);
  } catch {
    ctas = m[1]
      .replace(/[[\]"]/g, '')
      .split(',')
      .map((s) => s.trim());
  }
  return {
    text: text.replace(CTA_RE, '').trim(),
    ctas: ctas.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim().slice(0, 40)).slice(0, 4),
  };
}

const featureCache = new Map<string, { at: number; v: { hasDocs: boolean; hasDatasets: boolean; hasMedia: boolean } }>();
async function agentFeatures(agentId: string) {
  const hit = featureCache.get(agentId);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const [docs, ds, media] = await Promise.all([
    col.documents(agentId).where('status', '==', 'ready').limit(1).get(),
    col.datasets(agentId).where('enabled', '==', true).limit(1).get(),
    activeMedia(agentId),
  ]);
  const v = { hasDocs: !docs.empty, hasDatasets: !ds.empty, hasMedia: media.length > 0 };
  featureCache.set(agentId, { at: Date.now(), v });
  return v;
}
export function invalidateAgentFeatures(agentId: string) {
  featureCache.delete(agentId);
}

/**
 * Turno conversacional con Claude: ciclo agéntico con herramientas (RAG, APIs,
 * flujos de acción, distribuidores, Recovery) y streaming de texto.
 */
export async function runTurn(p: {
  agent: Agent;
  session: Session;
  channel: Channel;
  userContent: string | any[];
  site?: Site | null;
  recovery?: RecoveryContext | null;
  onEvent?: (e: ChatEvent) => void;
}): Promise<TurnResult> {
  const { agent, session, channel, site, recovery } = p;
  const emit = p.onEvent || (() => undefined);
  const model = agent.model?.chat || config.claude.chatModel;
  const usage = emptyUsage();

  const ctx: ToolContext = { agent, session, site, channel, recovery, media: [], followUps: [], emit, sessionPatch: {} };
  const tools = buildTools(ctx, await agentFeatures(agent.id));
  const apiTools = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const system = await buildSystemPrompt({ agent, session, channel, site, recovery });
  const history = await loadHistory(session.id);
  const userBlocks = typeof p.userContent === 'string' ? [{ type: 'text', text: p.userContent }] : p.userContent;
  const messages: any[] = [...history, { role: 'user', content: userBlocks }];
  const toStore: Omit<StoredMessage, 'seq'>[] = [
    {
      role: 'user',
      kind: 'user',
      content: userBlocks,
      channel,
      display: { text: userBlocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') || '[adjunto]' },
    },
  ];

  let finalText = '';
  try {
    for (let iter = 0; iter < config.claude.maxToolIterations; iter++) {
      const stream = claude().messages.stream({
        model,
        max_tokens: agent.model?.maxTokens || 1500,
        temperature: agent.model?.temperature ?? 0.3,
        system,
        tools: apiTools as any,
        messages,
      });
      let streamed = '';
      stream.on('text', (delta: string) => {
        streamed += delta;
        emit({ type: 'delta', text: delta });
      });
      const msg: any = await stream.finalMessage();
      addUsage(usage, msg.usage);
      const toolUses = msg.content.filter((b: any) => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: msg.content });

      if (msg.stop_reason !== 'tool_use' || !toolUses.length) {
        finalText = msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
        const { text, ctas } = splitCtas(finalText);
        toStore.push({
          role: 'assistant',
          kind: 'assistant',
          content: msg.content,
          channel,
          display: { text, ctas, media: ctx.media },
        });
        finalText = text;
        if (ctas.length) emit({ type: 'ctas', ctas });
        const cost = costUsd(model, usage);
        await appendMessages(session.id, toStore);
        await touchSession(session.id, ctx.sessionPatch, usage, cost, 2);
        await recordStats(agent.id, {
          interactions: 1,
          usage,
          cost,
          origin: session.origin,
          siteKey: session.siteKey,
          campaignId: session.campaignId,
          channel,
        });
        emit({ type: 'done', text, ctas, media: ctx.media, followUps: ctx.followUps });
        return { text, ctas, media: ctx.media, followUps: ctx.followUps, usage, costUsd: cost };
      }

      // Texto intermedio (antes de herramientas): se separa visualmente
      if (streamed.trim()) emit({ type: 'delta', text: '\n\n' });
      toStore.push({ role: 'assistant', kind: 'tool_use', content: msg.content, channel, display: null });
      const results = await Promise.all(
        toolUses.map(async (tu: any) => {
          emit({ type: 'tool', name: tu.name, status: 'start' });
          const r = await runTool(tools, tu.name, tu.input, ctx);
          emit({ type: 'tool', name: tu.name, status: 'end' });
          return { type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
        }),
      );
      messages.push({ role: 'user', content: results });
      toStore.push({ role: 'user', kind: 'tool_result', content: results, channel, display: null });
    }
    // Se agotaron las iteraciones
    const text = 'Disculpa, no pude completar la solicitud en este momento. ¿Puedes intentarlo de nuevo o reformular tu pregunta?';
    toStore.push({ role: 'assistant', kind: 'assistant', content: [{ type: 'text', text }], channel, display: { text } });
    const cost = costUsd(model, usage);
    await appendMessages(session.id, toStore);
    await touchSession(session.id, ctx.sessionPatch, usage, cost, 2);
    emit({ type: 'done', text, ctas: [], media: ctx.media, followUps: ctx.followUps });
    return { text, ctas: [], media: ctx.media, followUps: ctx.followUps, usage, costUsd: cost };
  } catch (e: any) {
    logger.error('Error en turno de chat', { sessionId: session.id, agentId: agent.id, error: e });
    emit({ type: 'error', message: 'Ocurrió un problema al generar la respuesta. Intenta de nuevo.' });
    throw e;
  }
}
