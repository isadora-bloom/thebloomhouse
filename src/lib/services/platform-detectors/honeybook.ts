/**
 * HoneyBook — project / lead CSV export.
 *
 * HoneyBook exports come in two shapes the coordinator might paste:
 *   1. "Projects" export — one row per project (couple). Columns include
 *      Project Name / Client Name / Client Email / Project Date / Lead
 *      Source / Stage / Status / Type.
 *   2. "Leads" export — pre-project leads. Same column family with
 *      slightly different header casing.
 *
 * Both have a recognisable signature compared to Knot/WeddingWire (which
 * are visitor-activity exports, not project exports). The Stage values
 * are HoneyBook-specific ("Inquiry", "Proposal Sent", "Booked",
 * "Completed") and don't appear in other platforms' exports.
 *
 * For this detector we focus on the column signature; row-level
 * extraction reuses the existing CRM-import path (importLeads).
 */

import type { PlatformDetector, UniversalSignalRow } from './types'

const HONEYBOOK_HEADERS = [
  /^project\s*name$/i,
  /^client\s*name$/i,
  /^client\s*email$/i,
  /^project\s*date$/i,
  /^lead\s*source$/i,
  /^stage$/i,
  /^project\s*type$/i,
] as const

const HONEYBOOK_STAGE_VALUES = new Set([
  'inquiry',
  'proposal sent',
  'proposal accepted',
  'booked',
  'in progress',
  'completed',
  'closed',
  'lost',
])

function findCol(headers: readonly string[], rx: RegExp): number {
  for (let i = 0; i < headers.length; i++) {
    if (rx.test(headers[i].trim())) return i
  }
  return -1
}

function lc(v: string | undefined | null): string {
  return (v ?? '').trim().toLowerCase()
}

function safe(headers: readonly string[], row: readonly string[], rx: RegExp): string {
  const i = findCol(headers, rx)
  return i >= 0 ? (row[i] ?? '').trim() : ''
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

export const HoneyBookDetector: PlatformDetector = {
  key: 'honeybook',
  displayName: 'HoneyBook',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let confidence = 0

    // Column signature: 4+ HoneyBook-shaped headers → strong match.
    const headerHits = HONEYBOOK_HEADERS.filter((rx) =>
      headers.some((h) => rx.test(h.trim())),
    ).length
    if (headerHits >= 4) {
      confidence += 70
      evidence.push(`${headerHits}/${HONEYBOOK_HEADERS.length} HoneyBook column patterns matched`)
    } else if (headerHits >= 2) {
      confidence += 30
      evidence.push(`${headerHits}/${HONEYBOOK_HEADERS.length} HoneyBook column patterns matched (weak)`)
    } else {
      return null
    }

    // Stage column with HoneyBook-specific values → strongest signal.
    const stageIdx = findCol(headers, /^stage$/i)
    if (stageIdx >= 0) {
      const stageValues = new Set(sampleRows.map((r) => lc(r[stageIdx])).filter(Boolean))
      const stageHits = [...stageValues].filter((v) => HONEYBOOK_STAGE_VALUES.has(v)).length
      if (stageHits >= 1) {
        confidence += 25
        evidence.push(`Stage column carries HoneyBook stage values (${stageHits} matched)`)
      }
    }

    // Lead Source column existence is HoneyBook-shaped vocabulary
    // ("Bridebook", "The Knot", "Wedding Wire", "Referral"). We don't
    // gate on values because they are coordinator-editable and vary.
    if (findCol(headers, /^lead\s*source$/i) >= 0) {
      confidence += 5
      evidence.push('Lead Source column present')
    }

    return { confidence: Math.min(100, confidence), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const clientName = safe(headers, row, /^client\s*name$/i)
    const { first, last } = splitName(clientName)
    const email = safe(headers, row, /^client\s*email$/i)
    const stage = lc(safe(headers, row, /^stage$/i))
    const projectDate = safe(headers, row, /^project\s*date$/i)
    const source = safe(headers, row, /^lead\s*source$/i)
    const projectName = safe(headers, row, /^project\s*name$/i)

    // Action class derived from HoneyBook stage. Keeps the universal
    // shape consistent with Knot/WeddingWire even though HoneyBook
    // exports projects, not visitor events.
    const actionClass =
      stage === 'inquiry'
        ? 'message'
        : stage === 'proposal sent'
        ? 'quote'
        : stage === 'proposal accepted' || stage === 'booked'
        ? 'mark_booked'
        : stage === 'completed'
        ? 'mark_complete'
        : stage === 'lost' || stage === 'closed'
        ? 'mark_lost'
        : 'other'

    return {
      name_raw: clientName || null,
      first_name: first || null,
      last_initial: last && last.length === 1 ? last : null,
      last_name: last && last.length > 1 ? last : null,
      username: null,
      email: email || null,
      city: null,
      state: null,
      country: null,
      action_class: actionClass,
      signal_date: projectDate || null,
      source_context: projectName ? `${stage} on HoneyBook (${projectName})` : `${stage} on HoneyBook`,
      raw_row: Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])),
    }
  },
}
