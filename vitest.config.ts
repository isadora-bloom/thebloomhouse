import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.unit.test.ts',
      // Operator scripts that carry real logic get unit tests too. First
      // one is scripts/demo-reseed (NOVEMBER-PLAN.md W19); its generator
      // and plan builder are pure, so they are worth pinning.
      'scripts/**/__tests__/**/*.test.ts',
      // Isolation battery (NOVEMBER-PLAN.md wave 5, W38) — proves the
      // walker + checker catch a leak against a fake client, no database.
      'tests/isolation/**/*.test.ts',
    ],
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
