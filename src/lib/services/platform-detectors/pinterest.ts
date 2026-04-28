/**
 * Pinterest — saves / engagement export.
 *
 * Common columns across Pinterest exports:
 *   Pinner | Pin URL | Board | Saved Date
 * Or the analytics dashboard variant:
 *   Username | Action | Pin | Date
 *
 * Best-guess detector pending real exports. Refine when actual CSVs land.
 */

import { parseVendorDateIso } from '../parse-vendor-date'
import type { PlatformDetector, UniversalSignalRow } from './types'

function findCol(headers: readonly string[], rx: RegExp): number {
  for (let i = 0; i < headers.length; i++) {
    if (rx.test(headers[i].trim())) return i
  }
  return -1
}

export const PinterestDetector: PlatformDetector = {
  key: 'pinterest',
  displayName: 'Pinterest — saves / engagement',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let score = 0

    const hPin = findCol(headers, /^(pin|pin\s*url|pin\s*link)$/i)
    const hPinner = findCol(headers, /^(pinner|saver|user|username)$/i)
    const hBoard = findCol(headers, /^(board|board\s*name)$/i)
    const hDate = findCol(headers, /^(saved\s*date|date|saved|created)$/i)

    if (hPin >= 0) { score += 35; evidence.push(`header: ${headers[hPin]}`) }
    if (hBoard >= 0) { score += 25; evidence.push(`header: ${headers[hBoard]}`) }
    if (hPinner >= 0) { score += 20; evidence.push(`header: ${headers[hPinner]}`) }
    if (hDate >= 0) { score += 10; evidence.push(`header: ${headers[hDate]}`) }

    // Content fingerprint: pinterest.com URLs.
    let pinUrlHits = 0
    for (const r of sampleRows.slice(0, 30)) {
      if (r.some((c) => /pinterest\.com/i.test(c))) pinUrlHits++
    }
    if (pinUrlHits >= 2) {
      score += 15
      evidence.push('content: pinterest.com URLs in rows')
    }

    if (score < 60) return null
    return { confidence: Math.min(score, 100), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const hPin = findCol(headers, /^(pin|pin\s*url|pin\s*link)$/i)
    const hPinner = findCol(headers, /^(pinner|saver|user|username)$/i)
    const hBoard = findCol(headers, /^(board|board\s*name)$/i)
    const hDate = findCol(headers, /^(saved\s*date|date|saved|created)$/i)
    const hAction = findCol(headers, /^(action|activity)$/i)

    const rawRow: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) rawRow[headers[i]] = row[i] ?? ''

    const pinner = (hPinner >= 0 ? row[hPinner] : '')?.trim() || null
    const board = (hBoard >= 0 ? row[hBoard] : '')?.trim() || null
    const action = (hAction >= 0 ? row[hAction] : '')?.toLowerCase() ?? ''

    // Pinterest CSV pinners are usually usernames; we don't usually
    // have a "Full Name" column.
    const username = pinner ? pinner.replace(/^@/, '') : null
    const action_class = /save|repin/.test(action) || hPin >= 0 ? 'save' :
                         /click/.test(action) ? 'click' :
                         'save'

    return {
      name_raw: pinner,
      first_name: null,
      last_initial: null,
      last_name: null,
      username,
      email: null,
      city: null,
      state: null,
      country: null,
      action_class,
      signal_date: parseVendorDateIso(hDate >= 0 ? row[hDate] : null),
      source_context: board
        ? `Saved to "${board}" on Pinterest`
        : 'Pinterest save',
      raw_row: rawRow,
    }
  },
}
