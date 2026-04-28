/**
 * WeddingWire — vendor analytics CSV.
 *
 * WeddingWire's contributor dashboard exports activity rows similar to
 * Knot but with different column labels:
 *   "Activity Type","User","Profile Views","Last Visit","City","State"
 * Or sometimes:
 *   "Type","Name","Date","Location"
 *
 * This detector is a best-guess based on common patterns; it will be
 * refined as actual exports arrive. The column-pattern matching is
 * deliberately broad — if it loses to the_knot detector it just means
 * the CSV was Knot, not WeddingWire.
 */

import { parseVendorDateIso } from '../parse-vendor-date'
import type { PlatformDetector, UniversalSignalRow } from './types'

function findCol(headers: readonly string[], rx: RegExp): number {
  for (let i = 0; i < headers.length; i++) {
    if (rx.test(headers[i].trim())) return i
  }
  return -1
}

function lc(v: string | undefined | null): string {
  return (v ?? '').trim().toLowerCase()
}

function actionClass(activity: string): string {
  const a = lc(activity)
  if (/profile.?view|view/.test(a)) return 'view'
  if (/save|favorite/.test(a)) return 'save'
  if (/contact|message|inquir/.test(a)) return 'message'
  if (/click/.test(a)) return 'click'
  if (/review/.test(a)) return 'review'
  return 'other'
}

function parseFirstLast(raw: string): { first_name: string | null; last_initial: string | null; last_name: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { first_name: null, last_initial: null, last_name: null }
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first_name: null, last_initial: null, last_name: null }
  if (parts.length === 1) return { first_name: parts[0], last_initial: null, last_name: null }
  const last = parts[parts.length - 1].replace(/\.$/, '')
  const first = parts.slice(0, -1).join(' ')
  if (last.length === 1) {
    return { first_name: first, last_initial: last.toUpperCase(), last_name: null }
  }
  return { first_name: first, last_initial: last.charAt(0).toUpperCase(), last_name: last }
}

export const WeddingWireDetector: PlatformDetector = {
  key: 'wedding_wire',
  displayName: 'WeddingWire — Activity export',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let score = 0

    const hActivity = findCol(headers, /^(activity|activity\s*type|type|event)$/i)
    const hUser = findCol(headers, /^(user|name|visitor)$/i)
    const hDate = findCol(headers, /^(date|last\s*visit|when)$/i)
    if (hActivity >= 0) { score += 25; evidence.push(`header: ${headers[hActivity]}`) }
    if (hUser >= 0) { score += 25; evidence.push(`header: ${headers[hUser]}`) }
    if (hDate >= 0) { score += 25; evidence.push(`header: ${headers[hDate]}`) }

    // Content fingerprint: WeddingWire uses "Profile Views" and the
    // word "Contact" in activity columns; row content with literal
    // "weddingwire.com" or "WeddingWire" is also a hit.
    let contentHit = false
    for (const r of sampleRows.slice(0, 50)) {
      const joined = r.join(' | ').toLowerCase()
      if (joined.includes('weddingwire') || joined.includes('profile view')) {
        contentHit = true
        break
      }
    }
    if (contentHit) {
      score += 20
      evidence.push('content: weddingwire / profile view phrases')
    }

    if (score < 60) return null
    return { confidence: Math.min(score, 100), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const hActivity = findCol(headers, /^(activity|activity\s*type|type|event)$/i)
    const hUser = findCol(headers, /^(user|name|visitor)$/i)
    const hDate = findCol(headers, /^(date|last\s*visit|when)$/i)
    const hCity = findCol(headers, /^city$/i)
    const hState = findCol(headers, /^state$/i)
    const hLocation = findCol(headers, /^location$/i)

    const rawRow: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) rawRow[headers[i]] = row[i] ?? ''

    const userRaw = (hUser >= 0 ? row[hUser] : '') ?? ''
    const { first_name, last_initial, last_name } = parseFirstLast(userRaw)
    const activity = (hActivity >= 0 ? row[hActivity] : '') ?? ''
    const dateRaw = (hDate >= 0 ? row[hDate] : '') ?? ''

    let city: string | null = (hCity >= 0 ? row[hCity] : '')?.trim() || null
    let state: string | null = (hState >= 0 ? row[hState] : '')?.trim() || null
    if (!city && hLocation >= 0) {
      // "City, ST" → split into two
      const loc = (row[hLocation] ?? '').trim()
      const m = loc.match(/^(.+?),\s*([A-Z]{2})$/)
      if (m) { city = m[1]; state = m[2] }
      else if (loc) city = loc
    }

    return {
      name_raw: userRaw.trim() || null,
      first_name,
      last_initial,
      last_name,
      username: null,
      email: null,
      city,
      state,
      country: null,
      action_class: actionClass(activity),
      signal_date: parseVendorDateIso(dateRaw),
      source_context: activity ? `${activity} on WeddingWire` : 'WeddingWire activity',
      raw_row: rawRow,
    }
  },
}
