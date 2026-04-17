import { test } from '@playwright/test'

/**
 * §9 Sage Persistent Rate Limiter — NEEDS BUILDING
 *
 * BUG-12: The current rate limiter for /api/couple/sage is in-memory only
 *   and resets on process restart. It must be backed by a persistent store
 *   (Supabase table or Redis) with a per-couple sliding window.
 */

test.describe.skip('§9 Sage persistent rate limiter (BUG-12)', () => {
  test('429 is returned after N requests in window from same couple', () => {})
  test('window resets correctly after time elapses', () => {})
  test('limiter state survives server restart', () => {})
})
