/**
 * Aisle Planner adapter (T5-followup-Y / Stream GG primitives-aware stub).
 *
 * SCAFFOLD ONLY — `ready: false`. When the first real Aisle Planner
 * export lands, fill in the COLUMN_HINTS map and wire up the primitives
 * just like `honeybook.ts` does. The actual parsing logic should be a
 * thin shell over the primitives in `crm-import/primitives/`:
 *
 *   - field-detector  — fuzzy column-name matching
 *   - couple-parser   — Aisle Planner ships "Couple" as one cell
 *                       ("FirstA LastA, FirstB LastB" or "FirstA &
 *                       FirstB Last"); the primitive's shared-surname
 *                       path handles both
 *   - status-deriver  — Aisle Planner statuses include "On Hold" which
 *                       maps to inquiry+hold-note; pass the alias map
 *                       through the deriver
 *   - financial-parser — "Estimated Budget" is the couple's stated
 *                       budget not what they paid — surface as a
 *                       coordinator question via validate()
 *
 * Aisle Planner export format (typical, as of 2026-05):
 *   File: CSV from CRM → Leads → "Export to CSV", or Bookings list.
 *   Columns (Aisle Planner field → typical header):
 *     - "Lead ID"               → source_id / crm_external_id
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
 *   1. Use parseCoupleFromCell on "Couple" — handles both
 *      "FirstA LastA, FirstB LastB" and "FirstA & FirstB Last".
 *   2. Decide whether "Estimated Budget" → booking_value is misleading
 *      (it's the couple's stated budget, not what they paid). Surface
 *      as a validate() question: "Use Estimated Budget as booking_value?"
 *   3. "On Hold" status doesn't have a clean Bloom equivalent —
 *      probably maps to 'inquiry' with a hold flag in import_warnings.
 *      Add to per-CRM aliases for status-deriver.
 *   4. Aisle Planner messages export sometimes includes attachment
 *      placeholders ([attachment]) — strip these in body field.
 *   5. Aisle Planner has no Tax / Gratuity / Refunded columns — leave
 *      those NULL on weddings (migration 175).
 */

import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  CommitResult,
} from './index'
// Pre-import the primitives so the next dev sees where to find shared
// code without going to look for it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { findColumnIndex } from './primitives/field-detector'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { parseCoupleFromCell } from './primitives/couple-parser'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { deriveStatus, DEFAULT_STATUS_ALIASES } from './primitives/status-deriver'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { parseFinancials } from './primitives/financial-parser'

async function parseAislePlanner(_config: AdapterConfig): Promise<ParseResult> {
  return {
    ok: false,
    rows: [],
    errors: [
      'Aisle Planner adapter is scaffold-only. Use the Generic CSV ' +
      'adapter with a column-mapping JSON until a dev wires this up ' +
      'against a real export. See src/lib/services/crm-import/aisleplanner.ts ' +
      'for the documented format and src/lib/services/crm-import/primitives/ ' +
      'for the shared parsing primitives.',
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
