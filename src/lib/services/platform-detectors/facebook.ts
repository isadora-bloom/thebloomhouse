/**
 * Facebook — page likes / engagement export.
 *
 * Common columns: Name | Page Like Source | Date Liked, or
 *   Name | Action | Date | Post URL
 */

import { parseVendorDateIso } from '../parse-vendor-date'
import type { PlatformDetector, UniversalSignalRow } from './types'

function findCol(headers: readonly string[], rx: RegExp): number {
  for (let i = 0; i < headers.length; i++) {
    if (rx.test(headers[i].trim())) return i
  }
  return -1
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

export const FacebookDetector: PlatformDetector = {
  key: 'facebook',
  displayName: 'Facebook — page likes / engagement',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let score = 0

    const hName = findCol(headers, /^(name|user|liker)$/i)
    const hLikeSource = findCol(headers, /^(page\s*like\s*source|like\s*source|source)$/i)
    const hAction = findCol(headers, /^(action|activity|engagement\s*type)$/i)
    const hDate = findCol(headers, /^(date|date\s*liked|created)$/i)
    const hPost = findCol(headers, /^(post\s*url|post)$/i)

    if (hName >= 0) { score += 20; evidence.push(`header: ${headers[hName]}`) }
    if (hLikeSource >= 0) { score += 35; evidence.push(`header: ${headers[hLikeSource]} (FB-specific)`) }
    if (hPost >= 0) { score += 15; evidence.push(`header: ${headers[hPost]}`) }
    if (hAction >= 0) { score += 10; evidence.push(`header: ${headers[hAction]}`) }
    if (hDate >= 0) { score += 10; evidence.push(`header: ${headers[hDate]}`) }

    // Content fingerprint: facebook.com URLs.
    let fbHit = false
    for (const r of sampleRows.slice(0, 30)) {
      if (r.some((c) => /facebook\.com/i.test(c))) { fbHit = true; break }
    }
    if (fbHit) {
      score += 15
      evidence.push('content: facebook.com URLs in rows')
    }

    if (score < 60) return null
    return { confidence: Math.min(score, 100), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const hName = findCol(headers, /^(name|user|liker)$/i)
    const hAction = findCol(headers, /^(action|activity|engagement\s*type)$/i)
    const hLikeSource = findCol(headers, /^(page\s*like\s*source|like\s*source|source)$/i)
    const hDate = findCol(headers, /^(date|date\s*liked|created)$/i)

    const rawRow: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) rawRow[headers[i]] = row[i] ?? ''

    const name = (hName >= 0 ? row[hName] : '') ?? ''
    const { first_name, last_initial, last_name } = parseFirstLast(name)
    const action = ((hAction >= 0 ? row[hAction] : '') ?? '').toLowerCase()
    const likeSource = (hLikeSource >= 0 ? row[hLikeSource] : '') ?? ''

    let action_class: string
    if (likeSource && hAction < 0) action_class = 'follow'  // page like
    else if (/like/.test(action)) action_class = 'like'
    else if (/comment/.test(action)) action_class = 'comment'
    else if (/share/.test(action)) action_class = 'mention'
    else if (/click/.test(action)) action_class = 'click'
    else action_class = 'follow'

    return {
      name_raw: name.trim() || null,
      first_name,
      last_initial,
      last_name,
      username: null,
      email: null,
      city: null,
      state: null,
      country: null,
      action_class,
      signal_date: parseVendorDateIso(hDate >= 0 ? row[hDate] : null),
      source_context: likeSource
        ? `Facebook page like (source: ${likeSource})`
        : action
          ? `Facebook ${action}`
          : 'Facebook page like',
      raw_row: rawRow,
    }
  },
}
