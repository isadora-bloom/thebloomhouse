/**
 * Google Business — customer interactions / reviews / Q&A.
 *
 * Google Business profile manager exports common columns:
 *   Customer Name | Interaction Type | Date | Body
 *   Reviewer | Rating | Date | Review Text
 *
 * Distinguishing features: literal mentions of "Google" / "business
 * profile" / "Q&A", numeric Rating column for reviews, sometimes a
 * "Reply Status" column.
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

export const GoogleBusinessDetector: PlatformDetector = {
  key: 'google_business',
  displayName: 'Google Business — interactions / reviews',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let score = 0

    const hCustomer = findCol(headers, /^(customer|reviewer|name|customer\s*name)$/i)
    const hType = findCol(headers, /^(interaction\s*type|action|type|kind)$/i)
    const hDate = findCol(headers, /^(date|interaction\s*date|review\s*date)$/i)
    const hRating = findCol(headers, /^(rating|stars)$/i)
    const hBody = findCol(headers, /^(body|review\s*text|comment|message)$/i)

    if (hCustomer >= 0) { score += 25; evidence.push(`header: ${headers[hCustomer]}`) }
    if (hDate >= 0) { score += 15; evidence.push(`header: ${headers[hDate]}`) }
    if (hType >= 0) { score += 10; evidence.push(`header: ${headers[hType]}`) }
    if (hRating >= 0) { score += 10; evidence.push(`header: ${headers[hRating]} (review export)`) }
    if (hBody >= 0) { score += 10; evidence.push(`header: ${headers[hBody]}`) }

    // Content fingerprint: literal "Google" / "Q&A" / "Direction
    // request" phrases.
    let contentHit = false
    for (const r of sampleRows.slice(0, 30)) {
      const j = r.join(' | ').toLowerCase()
      if (j.includes('google business') || j.includes('q&a') || j.includes('direction request') || j.includes('photo viewed')) {
        contentHit = true
        break
      }
    }
    if (contentHit) {
      score += 30
      evidence.push('content: Google Business activity phrases')
    }

    if (score < 60) return null
    return { confidence: Math.min(score, 100), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const hCustomer = findCol(headers, /^(customer|reviewer|name|customer\s*name)$/i)
    const hType = findCol(headers, /^(interaction\s*type|action|type|kind)$/i)
    const hDate = findCol(headers, /^(date|interaction\s*date|review\s*date)$/i)
    const hRating = findCol(headers, /^(rating|stars)$/i)
    const hBody = findCol(headers, /^(body|review\s*text|comment|message)$/i)

    const rawRow: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) rawRow[headers[i]] = row[i] ?? ''

    const customer = (hCustomer >= 0 ? row[hCustomer] : '') ?? ''
    const { first_name, last_initial, last_name } = parseFirstLast(customer)
    const type = ((hType >= 0 ? row[hType] : '') ?? '').toLowerCase()
    const rating = hRating >= 0 ? row[hRating]?.trim() : ''

    let action_class: string
    if (rating) action_class = 'review'
    else if (/direction/.test(type)) action_class = 'visit'
    else if (/call/.test(type)) action_class = 'call'
    else if (/photo|view/.test(type)) action_class = 'view'
    else if (/q.?a|question/.test(type)) action_class = 'message'
    else if (/website|click/.test(type)) action_class = 'click'
    else action_class = 'other'

    return {
      name_raw: customer.trim() || null,
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
      source_context: rating
        ? `${rating}-star Google review`
        : type
          ? `${type} on Google Business`
          : 'Google Business activity',
      raw_row: rawRow,
    }
  },
}
