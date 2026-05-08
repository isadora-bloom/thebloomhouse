/**
 * Dubsado — freelance / wedding project CRM CSV export.
 *
 * Dubsado exports project + lead capture lists with columns:
 *   Project Title / Lead Capture Date / Status / Workflow /
 *   Client First Name / Client Last Name / Email / Phone
 *
 * Distinctive: split first/last name columns (vs HoneyBook's combined
 * Client Name) + "Workflow" column referencing Dubsado's workflow
 * system.
 */

import type { PlatformDetector, UniversalSignalRow } from './types'

const DUBSADO_HEADERS = [
  /^project\s*title$/i,
  /^lead\s*capture\s*date$/i,
  /^client\s*first\s*name$/i,
  /^client\s*last\s*name$/i,
  /^workflow$/i,
] as const

const DUBSADO_STATUS_VALUES = new Set([
  'lead',
  'proposal',
  'contract',
  'invoice',
  'paid',
  'archived',
  'lost',
  'completed',
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

export const DubsadoDetector: PlatformDetector = {
  key: 'dubsado',
  displayName: 'Dubsado',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let confidence = 0

    const headerHits = DUBSADO_HEADERS.filter((rx) =>
      headers.some((h) => rx.test(h.trim())),
    ).length
    if (headerHits >= 3) {
      confidence += 70
      evidence.push(`${headerHits}/${DUBSADO_HEADERS.length} Dubsado columns matched`)
    } else if (headerHits >= 2) {
      confidence += 25
      evidence.push(`${headerHits}/${DUBSADO_HEADERS.length} Dubsado columns matched (weak)`)
    } else {
      return null
    }

    const statusIdx = findCol(headers, /^status$/i)
    if (statusIdx >= 0) {
      const statusValues = new Set(sampleRows.map((r) => lc(r[statusIdx])).filter(Boolean))
      const statusHits = [...statusValues].filter((v) => DUBSADO_STATUS_VALUES.has(v)).length
      if (statusHits >= 1) {
        confidence += 20
        evidence.push(`Status column carries Dubsado values (${statusHits} matched)`)
      }
    }

    if (findCol(headers, /^workflow$/i) >= 0) {
      confidence += 10
      evidence.push('Workflow column (Dubsado-specific)')
    }

    return { confidence: Math.min(100, confidence), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const first = safe(headers, row, /^client\s*first\s*name$/i)
    const last = safe(headers, row, /^client\s*last\s*name$/i)
    const email = safe(headers, row, /^email$/i)
    const captureDate = safe(headers, row, /^lead\s*capture\s*date$/i)
    const status = lc(safe(headers, row, /^status$/i))
    const projectTitle = safe(headers, row, /^project\s*title$/i)

    const actionClass =
      status === 'lead'
        ? 'message'
        : status === 'proposal'
        ? 'quote'
        : status === 'contract' || status === 'invoice' || status === 'paid'
        ? 'mark_booked'
        : status === 'completed'
        ? 'mark_complete'
        : status === 'lost' || status === 'archived'
        ? 'mark_lost'
        : 'other'

    return {
      name_raw: [first, last].filter(Boolean).join(' ') || null,
      first_name: first || null,
      last_initial: last && last.length === 1 ? last : null,
      last_name: last && last.length > 1 ? last : null,
      username: null,
      email: email || null,
      city: null,
      state: null,
      country: null,
      action_class: actionClass,
      signal_date: captureDate || null,
      source_context: projectTitle ? `${status} on Dubsado (${projectTitle})` : `${status} on Dubsado`,
      raw_row: Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])),
    }
  },
}
