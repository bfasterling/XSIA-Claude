import type { FastifyInstance } from 'fastify';
import { getAgent, getAgentBySlug, getSite } from '../chat/agents.js';
import { createSession, getSession, listDisplayMessages, appendMessages } from '../chat/sessions.js';
import { runTurn, type ChatEvent } from '../chat/engine.js';
import { badRequest, notFound } from '../lib/http.js';
import { synthesize, transcribeAudio } from '../voice/voice.js';
import { config } from '../config.js';

/** API pública del chat (web, widget y voz). La sesión se identifica con un ID aleatorio no adivinable. */
export async function publicRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } };

  app.get('/agents/:slug', async (req) => {
    const { slug } = req.params as any;
    const { site } = req.query as any;
    const agent = await getAgentBySlug(slug);
    if (!agent || agent.status === 'inactive') throw notFound('Agente no disponible');
    if (!agent.distribution.published) {
      if (agent.distribution.redirectUrl) return { redirectUrl: agent.distribution.redirectUrl };
      throw notFound('Agente no publicado');
    }
    const s = await getSite(agent.id, site);
    return {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      welcomeMessage: agent.instructions.welcomeMessage,
      starterCtas: agent.distribution.starterCtas || [],
      theme: agent.distribution.theme,
      widget: agent.distribution.widget,
      site: s ? { key: s.key, name: s.name } : null,
      voice: agent.voice.enabled
        ? {
            enabled: true,
            mode: agent.voice.mode,
            languageCode: agent.voice.languageCode,
            silenceMs: agent.voice.silenceMs,
            sensitivity: agent.voice.sensitivity,
            serverTts: config.google.ttsEnabled,
          }
        : { enabled: false },
    };
  });

  app.post('/agents/:slug/sessions', limit, async (req) => {
    const { slug } = req.params as any;
    const body = (req.body || {}) as any;
    const agent = await getAgentBySlug(slug);
    if (!agent || agent.status === 'inactive' || !agent.distribution.published) throw notFound('Agente no disponible');
    const site = await getSite(agent.id, body.siteKey);
    const session = await createSession({
      agentId: agent.id,
      origin: 'standard',
      channel: body.channel === 'voice' ? 'voice' : 'web',
      siteKey: site?.key || null,
      meta: { referrer: String(body.referrer || '').slice(0, 500), userAgent: String(req.headers['user-agent'] || '').slice(0, 300) },
    });
    if (agent.instructions.welcomeMessage) {
      await appendMessages(session.id, [
        {
          role: 'assistant',
          kind: 'assistant',
          content: [],
          excludeFromModel: true,
          channel: 'web',
          display: { text: agent.instructions.welcomeMessage, ctas: agent.distribution.starterCtas || [] },
        },
      ]);
    }
    return { sessionId: session.id };
  });

  app.get('/sessions/:id/messages', async (req) => {
    const s = await getSession((req.params as any).id);
    if (!s) throw notFound('Sesión no encontrada');
    return { messages: await listDisplayMessages(s.id) };
  });

  /** Envía un mensaje y recibe la respuesta en streaming (Server-Sent Events) */
  app.post('/sessions/:id/messages', limit, async (req, reply) => {
    const session = await getSession((req.params as any).id);
    if (!session) throw notFound('Sesión no encontrada');
    if (session.origin !== 'standard') throw badRequest('Sesión no disponible en este canal');
    const body = (req.body || {}) as any;
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) throw badRequest('Mensaje vacío');
    const agent = await getAgent(session.agentId);
    if (!agent) throw notFound('Agente no disponible');
    const site = await getSite(agent.id, session.siteKey);
    const channel = body.channel === 'voice' ? 'voice' : 'web';

    reply.hijack();
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    });
    const send = (e: ChatEvent | { type: string; [k: string]: any }) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    try {
      await runTurn({ agent, session, channel, userContent: text, site, onEvent: send });
    } catch {
      /* el evento de error ya se emitió */
    } finally {
      clearInterval(ping);
      reply.raw.end();
    }
  });

  app.post('/voice/tts', limit, async (req) => {
    const { slug, text } = (req.body || {}) as any;
    const agent = await getAgentBySlug(slug);
    if (!agent || !agent.voice.enabled) throw notFound('Voz no habilitada');
    const audio = await synthesize(String(text || '').slice(0, 5000), agent.voice.voiceName, agent.voice.languageCode, agent.voice.speakingRate);
    return { audio, mime: 'audio/mpeg' };
  });

  app.post('/voice/stt', limit, async (req) => {
    const file = await (req as any).file();
    if (!file) throw badRequest('Audio requerido');
    const buf = await file.toBuffer();
    const lang = String((req.query as any).lang || 'es-MX');
    return { text: await transcribeAudio(buf, file.mimetype, lang) };
  });
}
