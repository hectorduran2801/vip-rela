import { defineConfig } from 'vitest/config';

// Reutiliza el arnés de @vip/db: PostgreSQL 16 temporal con todas las migraciones.
export default defineConfig({
  test: {
    globalSetup: ['../db/test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
