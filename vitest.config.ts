import { defineConfig } from 'vitest/config';

// Tests are pure math; skip the IWSDK dev plugin.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
