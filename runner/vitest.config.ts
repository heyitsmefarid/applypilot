import { defineConfig } from 'vitest/config';

// Playwright specs (tests/*.spec.ts) run with `npm run test:e2e`; Vitest covers pure helpers only.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
