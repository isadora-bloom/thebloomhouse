import { test } from '@playwright/test'

/**
 * §14 Data Export — NEEDS BUILDING
 *
 * GAP-10: No export flow exists. Venues should be able to export weddings,
 * guests, budget_items, and messages as CSV or JSON for record-keeping and
 * GDPR/data-portability compliance.
 */

test.describe.skip('§14 Data export (GAP-10)', () => {
  test('coordinator can export weddings as CSV', () => {})
  test('coordinator can export guests for a wedding as CSV', () => {})
  test('export is scoped to the signed-in venue only', () => {})
  test('couple can export their own wedding data (self-serve GDPR)', () => {})
})
