/**
 * The Knot — vendor visitor activities CSV.
 *
 * Real example (2026-04 Rixey Manor export):
 *   "Action Taken","Visitor Name","Date of Visit","City","State"
 *   "Storefront View","Kara P.","22-Apr-26","",""
 *   "Message","Marleny R.","21-Apr-26","CORAL SPRINGS","FL"
 *
 * Distinguishing features:
 *   - Headers: Action Taken / Visitor Name / Date of Visit / City / State
 *   - Action Taken values are platform-specific phrases:
 *     "Storefront View" / "Storefront Save" / "Message" /
 *     "Click to Website/Social" / "Couple unmarked as booked" /
 *     "Reviewed" / "Call"
 *   - Visitor Name is "First L." (first name + last-initial-with-dot),
 *     occasionally just " ." for anonymized rows.
 *   - Date of Visit is DD-MMM-YY (e.g. 22-Apr-26).
 */

import { parseVendorDateIso } from '../parse-vendor-date'
import type { PlatformDetector, UniversalSignalRow } from './types'

const KNOT_ACTIONS_LITERAL = new Set([
  'storefront view',
  'storefront save',
  'message',
  'click to website/social',
  'couple unmarked as booked',
  'couple marked as booked',
  'reviewed',
  'call',
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

/**
 * Map a Knot Action Taken phrase to the universal action_class.
 * Anything we don't recognize lands in 'other' rather than getting
 * dropped — the raw row is preserved in raw_row so the coordinator
 * can grep for it later.
 */
function knotActionClass(action: string): string {
  const a = lc(action)
  if (a === 'storefront view') return 'view'
  if (a === 'storefront save') return 'save'
  if (a === 'message') return 'message'
  if (a === 'click to website/social') return 'click'
  if (a === 'reviewed') return 'review'
  if (a === 'call') return 'call'
  if (a.startsWith('couple unmarked')) return 'unmark'
  if (a.startsWith('couple marked')) return 'mark_booked'
  return 'other'
}

/**
 * Parse "Kara P." / "Sarah  R." / "Denise  P." / " ." into structured
 * first_name + last_initial. Vendor exports inconsistently use 1 or 2
 * spaces; some entries are wholly anonymized as " ." (used by Knot
 * when the visitor is logged out or has opted out of name disclosure).
 *
 * Returns name_raw + first_name + last_initial. last_name stays null
 * because Knot only ships the initial.
 */
function parseKnotVisitorName(raw: string): {
  name_raw: string
  first_name: string | null
  last_initial: string | null
} {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '.') {
    return { name_raw: trimmed, first_name: null, last_initial: null }
  }
  // Split on whitespace, drop empty segments produced by double spaces.
  const parts = trimmed.split(/\s+/).filter((p) => p.length > 0)
  if (parts.length === 0) {
    return { name_raw: trimmed, first_name: null, last_initial: null }
  }
  if (parts.length === 1) {
    // "Kara" — first name only, no initial.
    return { name_raw: trimmed, first_name: parts[0], last_initial: null }
  }
  // "Kara P." — first + initial. The initial token is usually one
  // letter optionally followed by a dot; tolerate both "P" and "P.".
  const last = parts[parts.length - 1].replace(/\.$/, '')
  const first = parts.slice(0, -1).join(' ')
  if (last.length === 1 && /^[A-Za-z]$/.test(last)) {
    return { name_raw: trimmed, first_name: first, last_initial: last.toUpperCase() }
  }
  // Edge case: "Sarah Anne P." — multi-token first name. The trailing
  // single letter is the initial; the rest is first.
  return { name_raw: trimmed, first_name: first, last_initial: null }
}

export const TheKnotDetector: PlatformDetector = {
  key: 'the_knot',
  displayName: 'The Knot — Visitor activities',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let score = 0

    // Header signal: Knot exports always have these three columns
    // exactly. Each is worth 25 points; we want at least 60 to
    // confidently call it Knot.
    const hAction = findCol(headers, /^action\s*(taken)?$/i)
    const hVisitor = findCol(headers, /^visitor\s*(name)?$/i)
    const hDate = findCol(headers, /^date\s*(of\s*visit)?$/i)
    const hCity = findCol(headers, /^city$/i)
    const hState = findCol(headers, /^state$/i)
    if (hAction >= 0) { score += 25; evidence.push('header: Action Taken') }
    if (hVisitor >= 0) { score += 25; evidence.push('header: Visitor Name') }
    if (hDate >= 0) { score += 25; evidence.push('header: Date of Visit') }
    if (hCity >= 0) { score += 5; evidence.push('header: City') }
    if (hState >= 0) { score += 5; evidence.push('header: State') }

    // Content fingerprint: at least one row should carry a Knot-
    // specific action phrase. This is what differentiates Knot from
    // a CSV that happened to use similar headers.
    if (hAction >= 0) {
      const seen = new Set<string>()
      for (const r of sampleRows.slice(0, 50)) {
        const a = lc(r[hAction])
        if (KNOT_ACTIONS_LITERAL.has(a)) seen.add(a)
      }
      if (seen.size > 0) {
        score += 20
        evidence.push(`content: ${[...seen].sort().join(' / ')} action phrases`)
      }
    }

    if (score < 60) return null
    return { confidence: Math.min(score, 100), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const hAction = findCol(headers, /^action\s*(taken)?$/i)
    const hVisitor = findCol(headers, /^visitor\s*(name)?$/i)
    const hDate = findCol(headers, /^date\s*(of\s*visit)?$/i)
    const hCity = findCol(headers, /^city$/i)
    const hState = findCol(headers, /^state$/i)

    const rawRow: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) rawRow[headers[i]] = row[i] ?? ''

    const visitorRaw = (hVisitor >= 0 ? row[hVisitor] : '') ?? ''
    const parsedName = parseKnotVisitorName(visitorRaw)
    const action = (hAction >= 0 ? row[hAction] : '') ?? ''
    const action_class = knotActionClass(action)
    const dateRaw = (hDate >= 0 ? row[hDate] : '') ?? ''
    const signal_date = parseVendorDateIso(dateRaw)
    const city = (hCity >= 0 ? row[hCity] : '')?.trim() || null
    const state = (hState >= 0 ? row[hState] : '')?.trim() || null

    return {
      name_raw: parsedName.name_raw || null,
      first_name: parsedName.first_name,
      last_initial: parsedName.last_initial,
      last_name: null,
      username: null,
      email: null,
      city,
      state,
      country: null,
      action_class,
      signal_date,
      source_context: action ? `${action} on The Knot` : 'The Knot activity',
      raw_row: rawRow,
    }
  },
}
