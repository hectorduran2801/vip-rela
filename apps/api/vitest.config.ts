import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reutiliza el PostgreSQL temporal del paquete @vip/db (nunca el Supabase compartido).
    globalSetup: ['../../packages/db/test/global-setup.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
