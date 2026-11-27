import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '../auth.js';
import type { Tx } from '../db.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    /** Ejecuta consultas con la identidad del usuario: RLS y las funciones de la base validan que sea la administradora. */
    db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  }
}

/** Exige un JWT válido de Supabase (sin comprobar autorización). */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) await reply.code(401).send({ error: 'not_authenticated' });
}

export type Role = 'super_admin' | 'admin' | 'supervisor';
const roleCache = new Map<string, { role: Role | null; until: number }>();

async function roleOf(req: FastifyRequest): Promise<Role | null> {
  const id = req.user!.id;
  const hit = roleCache.get(id);
  if (hit && hit.until > Date.now()) return hit.role;
  const role = await req.db(async (tx) => (await tx.one(`select public.current_app_role() r`))!.r as Role | null);
  roleCache.set(id, { role, until: Date.now() + 30_000 });
  return role;
}

/**
 * Puerta de entrada por rol: JWT válido + rol permitido en PostgreSQL. Se cachea 30 s SOLO para no consultar en cada petición;
 * la base de datos vuelve a verificar rol y RLS en CADA operación, así que revocar un rol surte efecto en la base de inmediato.
 */
export const requireRole = (...allowed: Role[]) => async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (!req.user) return void (await reply.code(401).send({ error: 'not_authenticated' }));
  const role = await roleOf(req);
  if (!role || !allowed.includes(role)) await reply.code(403).send({ error: 'forbidden' });
};
export const requireStaff = requireRole('super_admin', 'admin', 'supervisor');   // lectura + registrar pagos
export const requireAdmin = requireRole('super_admin', 'admin');                 // operación completa
export const requireSuper = requireRole('super_admin');                          // usuarios, métodos de pago, configuración
export const resetRoleCache = (): void => roleCache.clear();
