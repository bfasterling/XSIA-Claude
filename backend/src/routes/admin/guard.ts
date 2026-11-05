import type { FastifyRequest } from 'fastify';
import { requireRole } from '../../lib/auth.js';
import type { Role } from '../../types.js';

/** Exige un rol mínimo para una ruta concreta */
export function guard(min: Role) {
  return async (req: FastifyRequest) => requireRole(req.user, min);
}
