import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getTaskHandler, RetryLater } from '../lib/tasks.js';
import { logger } from '../lib/logger.js';

/**
 * Endpoints del servicio worker (privado). Cloud Run exige un token OIDC de la cuenta
 * de servicio invocadora (Cloud Tasks / Cloud Scheduler); opcionalmente se valida un secreto compartido.
 */
export async function taskRoutes(app: FastifyInstance) {
  app.post('/:name', async (req, reply) => {
    if (config.tasks.sharedSecret && req.headers['x-tasks-secret'] !== config.tasks.sharedSecret) {
      return reply.status(403).send({ error: 'forbidden' });
    }
    const name = (req.params as any).name;
    const handler = getTaskHandler(name);
    if (!handler) return reply.status(404).send({ error: 'Tarea desconocida' });
    try {
      const result = await handler(req.body || {});
      return { ok: true, result: result ?? null };
    } catch (e: any) {
      if (e instanceof RetryLater) return reply.status(503).send({ retry: true });
      logger.error(`Tarea ${name} falló`, { error: e, payload: req.body });
      return reply.status(500).send({ error: String(e?.message || e) });
    }
  });
}
