import type { FastifyRequest } from 'fastify';
import { auth, col, FieldValue } from './firestore.js';
import { config } from '../config.js';
import { HttpError } from './http.js';
import type { Role } from '../types.js';

export interface AuthUser {
  uid: string;
  email: string;
  role: Role;
  name?: string;
}

const cache = new Map<string, { user: AuthUser; exp: number }>();
const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

/** Verifica el ID token de Firebase Auth y resuelve el rol desde /users/{uid} */
export async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'No autenticado');
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;

  let decoded: any;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch {
    throw new HttpError(401, 'Token inválido o expirado');
  }
  const email = String(decoded.email || '').toLowerCase();
  const ref = col.users().doc(decoded.uid);
  const snap = await ref.get();
  let role: Role | null = (snap.exists ? (snap.data() as any).role : null) || null;

  // Alta automática de administradores definidos en ADMIN_EMAILS
  if (!role && email && config.adminEmails.includes(email)) {
    role = 'admin';
    await ref.set({ email, role, name: decoded.name || '', createdAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  if (!role) {
    // Usuario autenticado sin rol asignado: se registra como pendiente
    if (!snap.exists)
      await ref.set({ email, role: null, name: decoded.name || '', createdAt: FieldValue.serverTimestamp() }, { merge: true });
    throw new HttpError(403, 'Tu usuario no tiene un rol asignado. Solicita acceso a un administrador.');
  }
  if ((snap.data() as any)?.disabled) throw new HttpError(403, 'Usuario deshabilitado');
  const user: AuthUser = { uid: decoded.uid, email, role, name: decoded.name };
  cache.set(token, { user, exp: Date.now() + 60_000 });
  return user;
}

export function requireRole(user: AuthUser, min: Role) {
  if (ROLE_RANK[user.role] < ROLE_RANK[min]) throw new HttpError(403, `Se requiere rol ${min}`);
}
