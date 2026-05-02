/**
 * HoneyBook adapter (T5-followup-Y / Pattern I closure).
 *
 * SCAFFOLD ONLY — calling parse / commit currently throws
 * "not yet implemented". Coordinators using HoneyBook should fall
 * through to the generic-csv adapter with a hand-built column mapping
 * until a dev sees a real export and fills in this file.
 *
 * HoneyBook export format (typical, as of 2026-05):
 *   File: CSV download from Projects → Export → "All projects".
 *   Columns (HoneyBook field → typical header):
 *     - "Project Name"          → identifier
 *     - "Client Name"           → couple name (single string)
 *     - "Client Email"          → primary email
 *     - "Client Phone"          → primary phone
 *     - "Project Date"          → wedding_date
 *     - "Project Value"         → booking_value (sometimes "Total Project Cost")
 *     - "Project Status"        → maps to weddings.status
 *         active / paid / inquiry / proposal_sent / signed_contract /
 *         completed / lost
 *     - "Lead Source"           → source (the_knot / instagram / etc.)
 *     - "Created Date"          → inquiry_date
 *     - "Booking Date"          → booked_at
 *     - "Notes"                 → notes
 *   Sub-files (separate CSV downloads):
 *     - Communications export   → interactions
 *     - Calendar / Meetings     → tours
 *
 * TODO (when first real export lands):
 *   1. Confirm header strings match the above.
 *   2. Split "Client Name" into partner1_first_name / partner1_last_name.
 *   3. Map HoneyBook status enum to Bloom's. "signed_contract" probably
 *      maps to 'booked', "active" likely to 'tour_completed' or 'proposal_sent'.
 *   4. Decide whether to require all 3 sub-files in one ZIP, or accept
 *      the projects-only file and let coordinator come back to import
 *      communications/tours later.
 *   5. Detect duplicate emails — HoneyBook lets you re-import the same
 *      project multiple times. De-dup on (email, wedding_date) pre-insert.
 */

import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  CommitResult,
} from './index'

async function parseHoneybook(_config: AdapterConfig): Promise<ParseResult> {
  return {
    ok: false,
    rows: [],
    errors: [
      'HoneyBook adapter is scaffold-only. Use the Generic CSV adapter ' +
      'with a column-mapping JSON until a dev wires this up against a ' +
      'real HoneyBook export. See src/lib/services/crm-import/honeybook.ts ' +
      'for the documented format.',
    ],
    warnings: [],
  }
}

function previewHoneybook(rows: NormalisedLeadRow[]): PreviewResult {
  return {
    rows: rows.slice(0, 50),
    total: rows.length,
    errors: [],
    warnings: [],
  }
}

export const honeybookAdapter: CrmAdapter = {
  name: 'honeybook',
  label: 'HoneyBook',
  description: 'Import projects + communications + meetings exports from HoneyBook. (Scaffold only — use Generic CSV in the meantime.)',
  ready: false,
  parse: parseHoneybook,
  preview: previewHoneybook,
  async commit(_args): Promise<CommitResult> {
    return {
      ok: false,
      weddingsInserted: 0,
      interactionsInserted: 0,
      toursInserted: 0,
      lostDealsInserted: 0,
      errors: ['HoneyBook adapter is scaffold-only. See parse() error message.'],
    }
  },
}
