/**
 * Aisle Planner adapter (T5-followup-Y / Pattern I closure).
 *
 * SCAFFOLD ONLY — falls through to generic-csv until a dev fills in
 * the parser against a real export.
 *
 * Aisle Planner export format (typical, as of 2026-05):
 *   File: CSV from CRM → Leads → "Export to CSV", or Bookings list.
 *   Columns (Aisle Planner field → typical header):
 *     - "Lead ID"               → source_id
 *     - "Couple"                → couple name (single string, comma-separated
 *                                  partner names — e.g. "Sarah Smith, James Lee")
 *     - "Email Address"         → partner1_email (sometimes 2 emails comma-sep)
 *     - "Phone"                 → partner1_phone
 *     - "Wedding Date"          → wedding_date
 *     - "Estimated Budget"      → booking_value (LOW estimate — coordinator
 *                                  needs to override post-import)
 *     - "Status"                → weddings.status. Aisle Planner statuses:
 *         New / In Progress / Booked / Completed / Lost / On Hold
 *     - "Source"                → source
 *     - "Created"               → inquiry_date
 *     - "Booked Date"           → booked_at
 *     - "Notes"                 → notes
 *   Sub-files:
 *     - Tasks export            → can derive some interactions
 *     - Messages export         → interactions (Aisle Planner has built-in
 *                                  email)
 *
 * TODO (when first real export lands):
 *   1. Split "Couple" into partner1 + partner2 — typically
 *      "FirstA LastA, FirstB LastB" or "FirstA & FirstB Last".
 *   2. Decide whether "Estimated Budget" → booking_value is misleading
 *      (it's the couple's stated budget, not what they paid). Maybe
 *      put it in notes instead and let the coordinator override.
 *   3. "On Hold" status doesn't have a clean Bloom equivalent —
 *      probably maps to 'inquiry' with a hold flag in notes.
 *   4. Aisle Planner messages export sometimes includes attachment
 *      placeholders ([attachment]) — strip these in body field.
 */

import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  CommitResult,
} from './index'

async function parseAislePlanner(_config: AdapterConfig): Promise<ParseResult> {
  return {
    ok: false,
    rows: [],
    errors: [
      'Aisle Planner adapter is scaffold-only. Use the Generic CSV ' +
      'adapter with a column-mapping JSON until a dev wires this up ' +
      'against a real export. See src/lib/services/crm-import/aisleplanner.ts ' +
      'for the documented format.',
    ],
    warnings: [],
  }
}

function previewAislePlanner(rows: NormalisedLeadRow[]): PreviewResult {
  return { rows: rows.slice(0, 50), total: rows.length, errors: [], warnings: [] }
}

export const aislePlannerAdapter: CrmAdapter = {
  name: 'aisle_planner',
  label: 'Aisle Planner',
  description: 'Import leads + tasks + messages from Aisle Planner. (Scaffold only — use Generic CSV in the meantime.)',
  ready: false,
  parse: parseAislePlanner,
  preview: previewAislePlanner,
  async commit(_args): Promise<CommitResult> {
    return {
      ok: false,
      weddingsInserted: 0,
      interactionsInserted: 0,
      toursInserted: 0,
      lostDealsInserted: 0,
      errors: ['Aisle Planner adapter is scaffold-only. See parse() error message.'],
    }
  },
}
