import { test } from '@playwright/test'

/**
 * §14 Data Export — PARTIAL
 *
 * Guest CSV export IS built (see e2e/sections/14a_guest_csv_export.spec.ts).
 *
 * The following remain unbuilt:
 *   - Budget CSV export in /couple/{slug}/budget — no export control wired
 *   - Timeline CSV/PDF export in /couple/{slug}/timeline — no export control
 *   - Coordinator-side wedding / guest / budget export at /portal/weddings/[id]
 *   - Self-serve "take my data with me" (GDPR) flow for couples
 */

test.describe.skip('§14 Data export — remaining scope (partial)', () => {
  test('coordinator can export guests for a wedding as CSV (portal-side)', () => {})
  test('couple can export budget_items as CSV from /couple/{slug}/budget', () => {})
  test('couple can export timeline as CSV/PDF from /couple/{slug}/timeline', () => {})
  test('export is scoped to the signed-in venue only (RLS enforcement)', () => {})
  test('couple can export their own wedding data (self-serve GDPR)', () => {})
})
