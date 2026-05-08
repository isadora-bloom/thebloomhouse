/**
 * Aisle Planner — wedding-planner workflow CSV export.
 *
 * Aisle Planner exports project / client lists with columns like:
 *   Project Name / Client Name / Project Date / Status / Phase /
 *   Vendor Type / Email
 *
 * Distinctive: "Phase" column with Aisle-Planner specific values
 * (Inquiry / Booking / Planning / Final Details / Wedding Day).
 */

import type { PlatformDetector, UniversalSignalRow } from './types'

const AISLE_PLANNER_HEADERS = [
  /^project\s*name$/i,
  /^client\s*name$/i,
  /^project\s*date$/i,
  /^phase$/i,
  /^vendor\s*type$/i,
  /^client\s*email$/i,
] as const

const AISLE_PLANNER_PHASE_VALUES = new Set([
  'inquiry',
  'booking',
  'planning',
  'final details',
  'wedding day',
  'post wedding',
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

export const AislePlannerDetector: PlatformDetector = {
  key: 'aisle_planner',
  displayName: 'Aisle Planner',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let confidence = 0

    const headerHits = AISLE_PLANNER_HEADERS.filter((rx) =>
      headers.some((h) => rx.test(h.trim())),
    ).length
    if (headerHits >= 4) {
      confidence += 70
      evidence.push(`${headerHits}/${AISLE_PLANNER_HEADERS.length} Aisle Planner columns matched`)
    } else if (headerHits >= 2) {
      confidence += 25
      evidence.push(`${headerHits}/${AISLE_PLANNER_HEADERS.length} Aisle Planner columns matched (weak)`)
    } else {
      return null
    }

    const phaseIdx = findCol(headers, /^phase$/i)
    if (phaseIdx >= 0) {
      const phaseValues = new Set(sampleRows.map((r) => lc(r[phaseIdx])).filter(Boolean))
      const phaseHits = [...phaseValues].filter((v) => AISLE_PLANNER_PHASE_VALUES.has(v)).length
      if (phaseHits >= 1) {
        confidence += 25
        evidence.push(`Phase column carries Aisle Planner values (${phaseHits} matched)`)
      }
    }

    return { confidence: Math.min(100, confidence), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const clientName = safe(headers, row, /^client\s*name$/i)
    const { first, last } = splitName(clientName)
    const email = safe(headers, row, /^client\s*email$/i)
    const projectDate = safe(headers, row, /^project\s*date$/i)
    const phase = lc(safe(headers, row, /^phase$/i))
    const projectName = safe(headers, row, /^project\s*name$/i)

    const actionClass =
      phase === 'inquiry'
        ? 'message'
        : phase === 'booking'
        ? 'quote'
        : phase === 'planning' || phase === 'final details'
        ? 'mark_booked'
        : phase === 'post wedding' || phase === 'wedding day'
        ? 'mark_complete'
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
      source_context: projectName ? `${phase} on Aisle Planner (${projectName})` : `${phase} on Aisle Planner`,
      raw_row: Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])),
    }
  },
}
