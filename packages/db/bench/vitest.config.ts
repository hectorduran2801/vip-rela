import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config';
export default mergeConfig(base, defineConfig({ test: { include: ['bench/**/*.test.ts'], testTimeout: 3_000_000 } }));
