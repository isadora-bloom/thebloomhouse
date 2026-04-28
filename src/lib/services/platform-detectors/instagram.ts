/**
 * Instagram — follower export OR post-engagement export.
 *
 * Two distinct shapes Instagram emits when you export from a business
 * account, both routed to source_platform='instagram' but with
 * different action_class:
 *
 *   Followers:    Username | Full Name | Followed You (date)
 *   Engagements:  Username | Full Name | Comment | Like Date / Comment Date
 *
 * Detector returns one universal row per CSV row regardless of which
 * shape; mapping picks the right action_class.
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

export const InstagramDetector: PlatformDetector = {
  key: 'instagram',
  displayName: 'Instagram — followers / engagements',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let score = 0

    const hUsername = findCol(headers, /^(username|handle|@)$/i)
    const hName = findCol(headers, /^(full\s*name|name|display\s*name)$/i)
    const hFollowed = findCol(headers, /^(followed\s*you|follow\s*date|date\s*followed)$/i)
    const hLikeOrComment = findCol(headers, /^(comment|like\s*date|comment\s*date|engagement\s*type)$/i)

    if (hUsername >= 0) { score += 30; evidence.push(`header: ${headers[hUsername]}`) }
    if (hName >= 0) { score += 20; evidence.push(`header: ${headers[hName]}`) }
    if (hFollowed >= 0) { score += 30; evidence.push(`header: ${headers[hFollowed]} (followers export)`) }
    if (hLikeOrComment >= 0) { score += 30; evidence.push(`header: ${headers[hLikeOrComment]} (engagements export)`) }

    // Content fingerprint: usernames almost always start with @ or
    // are all-lowercase + numbers with no spaces.
    if (hUsername >= 0) {
      let igLooking = 0
      for (const r of sampleRows.slice(0, 30)) {
        const u = (r[hUsername] ?? '').trim()
        if (u.startsWith('@') || /^[a-z0-9._]{3,}$/.test(u)) igLooking++
      }
      if (igLooking >= 3) {
        score += 10
        evidence.push('content: username column looks like IG handles')
      }
    }

    if (score < 50) return null
    return { confidence: Math.min(score, 100), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const hUsername = findCol(headers, /^(username|handle|@)$/i)
    const hName = findCol(headers, /^(full\s*name|name|display\s*name)$/i)
    const hFollowed = findCol(headers, /^(followed\s*you|follow\s*date|date\s*followed)$/i)
    const hCommentDate = findCol(headers, /^(comment\s*date|like\s*date|engagement\s*date|date)$/i)
    const hComment = findCol(headers, /^(comment|engagement\s*type|action)$/i)

    const rawRow: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) rawRow[headers[i]] = row[i] ?? ''

    const username = (hUsername >= 0 ? row[hUsername] : '')?.trim().replace(/^@/, '') || null
    const fullName = (hName >= 0 ? row[hName] : '') ?? ''
    const { first_name, last_initial, last_name } = parseFirstLast(fullName)

    // Action class: follow vs like vs comment depending on which
    // column was populated.
    let action_class: string
    let signal_date: string | null
    let source_context: string
    if (hFollowed >= 0 && (row[hFollowed] ?? '').trim()) {
      action_class = 'follow'
      signal_date = parseVendorDateIso(row[hFollowed])
      source_context = username
        ? `@${username} followed you on Instagram`
        : 'Instagram follow'
    } else {
      const commentText = (hComment >= 0 ? row[hComment] : '') ?? ''
      action_class = commentText.toLowerCase().includes('comment') ? 'comment' :
                     commentText.toLowerCase().includes('like') ? 'like' :
                     'mention'
      signal_date = parseVendorDateIso(hCommentDate >= 0 ? row[hCommentDate] : null)
      source_context = username
        ? `@${username} ${action_class}d on Instagram`
        : `Instagram ${action_class}`
    }

    return {
      name_raw: fullName.trim() || username || null,
      first_name,
      last_initial,
      last_name,
      username,
      email: null,
      city: null,
      state: null,
      country: null,
      action_class,
      signal_date,
      source_context,
      raw_row: rawRow,
    }
  },
}
