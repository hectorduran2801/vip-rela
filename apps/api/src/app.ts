import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { AuthError, makeVerifier, type AuthUser } from './auth.js';
import type { Config } from './config.js';
import { BillingEngine } from './billing-engine.js';
import { createDatabase, type Database } from './db.js';
import { poolOptions } from './pool-options.js';
import { explainDbError, mapDbError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { collectionRoutes } from './routes/collection.js';
import { exportRoutes } from './routes/exports.js';
import { healthRoutes } from './routes/health.js';
import { importRoutes } from './routes/imports.js';
import { paymentRoutes } from './routes/payments.js';
import { whatsappRoutes } from './routes/whatsapp.js';

export interface AppDeps { db?: Database; verify?: (token: string) => Promise<AuthUser>; fetch?: typeof fetch }

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers["apikey"]', 'req.headers.cookie', 'req.headers["x-api-key"]'] },
    bodyLimit: 1_000_000,
  });
  app.decorate('config', config);
  app.decorate('httpFetch', deps.fetch ?? fetch);

  const database = deps.db ?? (config.DATABASE_URL
    ? createDatabase(new pg.Pool({ ...poolOptions(config.DATABASE_URL), max: 10, keepAlive: true, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 }))
    : null);
  app.decorate('ownerDb', database);
  if (!database) app.log.error('DATABASE_URL no está definida: la API no puede atender peticiones autenticadas (usa «pnpm dev» o «pnpm dev:setup»).');
  const verify = deps.verify ?? makeVerifier(config);
  app.addHook('onClose', async () => { if (!deps.db) await database?.close(); });

  // Motor de cobranza: solo con base de datos propia (en pruebas con `deps.db` se instancia a mano). Un fallo nunca tumba la API.
  if (!deps.db && database && config.BILLING_ENGINE) {
    const engine = new BillingEngine({ db: database, log: app.log, intervalMs: config.BILLING_ENGINE_INTERVAL_SECONDS * 1000, timezone: config.APP_TIMEZONE });
    app.addHook('onReady', async () => { engine.start(); });
    app.addHook('onClose', async () => { await engine.stop(); });
  }

  await app.register(cors, { origin: config.CORS_ORIGINS, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['authorization', 'content-type'] });
  await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });

  app.decorateRequest('user', null);
  app.decorateRequest('db', null as never);
  app.addHook('onRequest', async (req) => {
    req.user = null;
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      try { req.user = await verify(h.slice(7)); } catch (e) { if (!(e instanceof AuthError)) throw e; }
    }
    req.db = (fn) => {
      if (!req.user) throw Object.assign(new Error('not_authenticated'), { statusCode: 401 });
      // Sin DATABASE_URL la API arrancó mal configurada: no es un problema de sesión del usuario, así que NO se responde 401.
      if (!database) throw Object.assign(new Error('database_not_configured'), { statusCode: 503 });
      return database.asUser(req.user.id, fn);
    };
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = mapDbError(err);
    if (mapped) {
      if (mapped.status >= 500) req.log.error({ err: { message: (err as Error).message, code: (err as { code?: string }).code } }, mapped.error);   // visible en el registro, sin secretos
      return reply.code(mapped.status).send({ error: mapped.error, ...explainDbError(err, mapped.error) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if ((err as Error).message === 'database_not_configured') return reply.code(503).send({ error: 'database_not_configured' });
    if (status && status < 500) return reply.code(status).send({ error: status === 401 ? 'not_authenticated' : (err as Error).message });
    req.log.error({ err: { message: (err as Error).message, code: (err as { code?: string }).code } }, 'unhandled');
    return reply.code(500).send({ error: 'internal_error' });   // sin detalles internos
  });

  await app.register(healthRoutes);
  await app.register(paymentRoutes, { prefix: '/api/v1' });
  await app.register(whatsappRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  await app.register(importRoutes, { prefix: '/api/v1' });
  await app.register(exportRoutes, { prefix: '/api/v1' });
  await app.register(collectionRoutes, { prefix: '/api/v1' });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { config: Config; httpFetch: typeof fetch; ownerDb: Database | null }
}
