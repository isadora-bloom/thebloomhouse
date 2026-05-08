/**
 * Tripleseat — events / venue CRM CSV export.
 *
 * Tripleseat exports event lead lists and event registers. Common
 * column shape:
 *   Event Name / Account Name / Event Date / Status / Lead Source /
 *   Booking Type / Account Owner / Total
 *
 * Distinctive: Status uses Tripleseat-specific values (Prospect /
 * Tentative / Definite / Closed). "Booking Type" column is a
 * Tripleseat-ism (wedding / corporate / social).
 */

import type { PlatformDetector, UniversalSignalRow } from './types'

const TRIPLESEAT_HEADERS = [
  /^event\s*name$/i,
  /^account\s*name$/i,
  /^event\s*date$/i,
  /^lead\s*source$/i,
  /^booking\s*type$/i,
  /^account\s*owner$/i,
] as const

const TRIPLESEAT_STATUS_VALUES = new Set([
  'prospect',
  'tentative',
  'definite',
  'closed',
  'cancelled',
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

export const TripleseatDetector: PlatformDetector = {
  key: 'tripleseat',
  displayName: 'Tripleseat',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let confidence = 0

    const headerHits = TRIPLESEAT_HEADERS.filter((rx) =>
      headers.some((h) => rx.test(h.trim())),
    ).length
    if (headerHits >= 4) {
      confidence += 70
      evidence.push(`${headerHits}/${TRIPLESEAT_HEADERS.length} Tripleseat columns matched`)
    } else if (headerHits >= 2) {
      confidence += 25
      evidence.push(`${headerHits}/${TRIPLESEAT_HEADERS.length} Tripleseat columns matched (weak)`)
    } else {
      return null
    }

    const statusIdx = findCol(headers, /^status$/i)
    if (statusIdx >= 0) {
      const statusValues = new Set(sampleRows.map((r) => lc(r[statusIdx])).filter(Boolean))
      const statusHits = [...statusValues].filter((v) => TRIPLESEAT_STATUS_VALUES.has(v)).length
      if (statusHits >= 1) {
        confidence += 25
        evidence.push(`Status column carries Tripleseat values (${statusHits} matched)`)
      }
    }

    if (findCol(headers, /^booking\s*type$/i) >= 0) {
      confidence += 5
      evidence.push('Booking Type column present')
    }

    return { confidence: Math.min(100, confidence), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const accountName = safe(headers, row, /^account\s*name$/i)
    const { first, last } = splitName(accountName)
    const eventDate = safe(headers, row, /^event\s*date$/i)
    const status = lc(safe(headers, row, /^status$/i))
    const eventName = safe(headers, row, /^event\s*name$/i)

    const actionClass =
      status === 'prospect'
        ? 'message'
        : status === 'tentative'
        ? 'quote'
        : status === 'definite' || status === 'closed'
        ? 'mark_booked'
        : status === 'cancelled' || status === 'lost'
        ? 'mark_lost'
        : 'other'

    return {
      name_raw: accountName || null,
      first_name: first || null,
      last_initial: last && last.length === 1 ? last : null,
      last_name: last && last.length > 1 ? last : null,
      username: null,
      email: null,
      city: null,
      state: null,
      country: null,
      action_class: actionClass,
      signal_date: eventDate || null,
      source_context: eventName ? `${status} on Tripleseat (${eventName})` : `${status} on Tripleseat`,
      raw_row: Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])),
    }
  },
}
