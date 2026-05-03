/**
 * Dubsado adapter (T5-followup-Y / Pattern I closure).
 *
 * SCAFFOLD ONLY — falls through to generic-csv until a dev fills in
 * the parser against a real export.
 *
 * Dubsado export format (typical, as of 2026-05):
 *   File: CSV download from Reports → Project Reports → "Export All".
 *   Columns (Dubsado field → typical header):
 *     - "Project Name"          → identifier
 *     - "Client First Name"     → partner1_first_name
 *     - "Client Last Name"      → partner1_last_name
 *     - "Client Email"          → partner1_email
 *     - "Client Phone"          → partner1_phone
 *     - "Project Date"          → wedding_date
 *     - "Total Invoiced"        → booking_value
 *     - "Project Status"        → weddings.status. Dubsado statuses:
 *         lead / active / archived / lost / completed
 *     - "Lead Source"           → source
 *     - "Date Created"          → inquiry_date
 *     - "Date Booked"           → booked_at (sometimes "Contract Signed Date")
 *     - "Internal Notes"        → notes
 *   Sub-files:
 *     - Workflow steps export   → can derive interactions (email send dates)
 *     - Form responses          → interactions (each form submission is one)
 *
 * TODO (when first real export lands):
 *   1. Confirm Dubsado actually splits first/last name (some accounts
 *      have it merged in "Client Name").
 *   2. Map Dubsado "active" status — could be tour_scheduled OR
 *      proposal_sent depending on whether a contract was sent.
 *      Probably need to look at "Contract Status" column too.
 *   3. Workflow-steps CSV is ordered by step not by date — need to
 *      reorder by "Completed Date" before mapping to interactions.
 *   4. Dubsado dates are MM/DD/YYYY in US accounts, ISO in EU. Check
 *      account locale before parsing.
 */

import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  CommitResult,
} from './index'

async function parseDubsado(_config: AdapterConfig): Promise<ParseResult> {
  return {
    ok: false,
    rows: [],
    errors: [
      'Dubsado adapter is scaffold-only. Use the Generic CSV adapter ' +
      'with a column-mapping JSON until a dev wires this up against a ' +
      'real Dubsado export. See src/lib/services/crm-import/dubsado.ts ' +
      'for the documented format.',
    ],
    warnings: [],
  }
}

function previewDubsado(rows: NormalisedLeadRow[]): PreviewResult {
  return { rows: rows.slice(0, 50), total: rows.length, errors: [], warnings: [] }
}

export const dubsadoAdapter: CrmAdapter = {
  name: 'dubsado',
  label: 'Dubsado',
  description: 'Import project reports + workflow steps + forms from Dubsado. (Scaffold only — use Generic CSV in the meantime.)',
  ready: false,
  parse: parseDubsado,
  preview: previewDubsado,
  async commit(_args): Promise<CommitResult> {
    return {
      ok: false,
      weddingsInserted: 0,
      interactionsInserted: 0,
      toursInserted: 0,
      lostDealsInserted: 0,
      errors: ['Dubsado adapter is scaffold-only. See parse() error message.'],
    }
  },
}
