import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { HttpError } from './lib/http.js';
import { logger } from './lib/logger.js';
import { registerTask } from './lib/tasks.js';
import { publicRoutes } from './routes/public.js';
import { webhookRoutes } from './routes/webhooks.js';
import { taskRoutes } from './routes/tasks.js';
import { adminRoutes } from './routes/admin/index.js';
import { ingestDocumentTask } from './rag/ingest.js';
import { crawlTask } from './rag/crawler.js';
import { importLeadsTask } from './recovery/imports.js';
import { recoveryTickTask, recoverySendTask } from './recovery/scheduler.js';
import { evaluateTask } from './recovery/evaluation.js';
import { processInboundTask } from './channels/whatsapp.js';

// Registro de tareas asíncronas (Cloud Tasks → worker)
registerTask('ingest-document', ingestDocumentTask);
registerTask('crawl', crawlTask);
registerTask('recovery-import', importLeadsTask);
registerTask('recovery-tick', recoveryTickTask);
registerTask('recovery-send', recoverySendTask);
registerTask('recovery-evaluate', evaluateTask);
registerTask('wa-inbound', processInboundTask);

const app = Fastify({
  logger: false,
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: true,
});

// Conserva el cuerpo crudo (necesario para validar la firma del webhook de Meta)
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  (req as any).rawBody = body;
  if (!body || !(body as Buffer).length) return done(null, {});
  try {
    done(null, JSON.parse((body as Buffer).toString('utf8')));
  } catch (e: any) {
    e.statusCode = 400;
    done(e, undefined);
  }
});

await app.register(cors, {
  origin: config.corsOrigins === '*' ? true : config.corsOrigins.split(',').map((s) => s.trim()),
  credentials: true,
});
await app.register(multipart, { limits: { fileSize: 31 * 1024 * 1024, files: 1 } });
await app.register(rateLimit, { global: false });

app.setErrorHandler((err: any, req, reply) => {
  const status = err instanceof HttpError ? err.statusCode : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) logger.error('Error no controlado', { url: req.url, error: err });
  reply.status(status).send({ error: status >= 500 ? 'Error interno' : err.message, details: err.details });
});

app.get('/healthz', async () => ({ ok: true, role: config.role, time: new Date().toISOString() }));

if (config.role === 'api' || config.role === 'all') {
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(webhookRoutes, { prefix: '/webhooks' });
}
if (config.role === 'worker' || config.role === 'all') {
  await app.register(taskRoutes, { prefix: '/tasks' });
}

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => logger.info(`XSIA Claude (${config.role}) escuchando en :${config.port}`))
  .catch((e) => {
    logger.error('No se pudo iniciar el servidor', { error: e });
    process.exit(1);
  });
