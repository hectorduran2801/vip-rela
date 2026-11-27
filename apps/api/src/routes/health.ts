import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({
    status: 'ok',
    whatsappDryRun: app.config.WHATSAPP_DRY_RUN,
  }));
};
