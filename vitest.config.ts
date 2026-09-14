import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    // W67 (2026-09-14 verification): a handful of suites do genuine setup
    // work in beforeEach/beforeAll (golden-cascade.test.ts's mock-Supabase
    // materialize() among them) that ran past the 10s default under
    // `--maxWorkers` load. Raise the hook budget rather than let those
    // suites flake; per-test bodies still use vitest's own default unless
    // a test overrides it directly (see GC-1 in golden-cascade.test.ts).
    hookTimeout: 20_000,
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
