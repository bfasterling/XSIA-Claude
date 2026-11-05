import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, type AuthUser } from '../../lib/auth.js';
import { agentRoutes } from './agents.js';
import { knowledgeRoutes } from './knowledge.js';
import { dataRoutes } from './data.js';
import { lineRoutes } from './lines.js';
import { recoveryRoutes } from './recovery.js';
import { systemRoutes } from './system.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}


export async function adminRoutes(app: FastifyInstance) {
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (req) => {
    req.user = await authenticate(req);
    requireRole(req.user, req.method === 'GET' ? 'viewer' : 'operator');
  });
  app.get('/me', async (req) => req.user);
  await app.register(agentRoutes);
  await app.register(knowledgeRoutes);
  await app.register(dataRoutes);
  await app.register(lineRoutes);
  await app.register(recoveryRoutes);
  await app.register(systemRoutes);
}
