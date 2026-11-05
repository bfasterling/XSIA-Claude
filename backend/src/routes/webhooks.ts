import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { handleWebhook, verifySignature } from '../channels/whatsapp.js';
import { logger } from '../lib/logger.js';

export async function webhookRoutes(app: FastifyInstance) {
  // Verificación del webhook (Meta App Dashboard → WhatsApp → Configuración)
  app.get('/whatsapp', async (req, reply) => {
    const q = req.query as any;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.whatsapp.verifyToken) {
      return reply.type('text/plain').send(q['hub.challenge']);
    }
    return reply.status(403).send('Forbidden');
  });

  app.post('/whatsapp', async (req, reply) => {
    const raw = (req as any).rawBody as Buffer;
    if (!verifySignature(raw || '', req.headers['x-hub-signature-256'] as string)) {
      logger.warn('Firma de webhook inválida');
      return reply.status(401).send('Invalid signature');
    }
    try {
      await handleWebhook(req.body);
    } catch (e) {
      logger.error('Error al procesar webhook de WhatsApp', { error: e });
    }
    return reply.status(200).send('OK');
  });
}
