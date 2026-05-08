/**
 * Zola — wedding registry + vendor marketplace lead export.
 *
 * Zola "vendor inquiries" CSV columns:
 *   Couple Name / Wedding Date / Email / Phone / Inquired On / Source /
 *   Message
 *
 * Distinctive: "Couple Name" header (Zola explicitly bills the
 * inquirer as a couple) + "Inquired On" date format. Source column
 * uses Zola-specific values ("Vendor Marketplace", "Pinned Vendor").
 */

import type { PlatformDetector, UniversalSignalRow } from './types'

const ZOLA_HEADERS = [
  /^couple\s*name$/i,
  /^wedding\s*date$/i,
  /^inquired\s*on$/i,
  /^email$/i,
  /^phone$/i,
] as const

const ZOLA_SOURCE_VALUES = new Set([
  'vendor marketplace',
  'pinned vendor',
  'vendor profile',
  'wedding website',
  'registry',
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

function splitCoupleName(full: string): { first: string; last: string } {
  // Zola "Couple Name" format examples: "Sarah & James", "Sarah Highland & James Roy",
  // "Sarah Highland". Extract the first partner's first + last.
  const cleaned = full.split(/\s*&\s*|\s+and\s+/i)[0]?.trim() ?? ''
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

export const ZolaDetector: PlatformDetector = {
  key: 'zola',
  displayName: 'Zola',

  detect(headers, sampleRows) {
    const evidence: string[] = []
    let confidence = 0

    const headerHits = ZOLA_HEADERS.filter((rx) =>
      headers.some((h) => rx.test(h.trim())),
    ).length
    if (headerHits >= 3) {
      confidence += 60
      evidence.push(`${headerHits}/${ZOLA_HEADERS.length} Zola columns matched`)
    } else if (headerHits >= 2) {
      confidence += 25
      evidence.push(`${headerHits}/${ZOLA_HEADERS.length} Zola columns matched (weak)`)
    } else {
      return null
    }

    // Couple Name column is the strongest single Zola signal.
    if (findCol(headers, /^couple\s*name$/i) >= 0) {
      confidence += 20
      evidence.push('Couple Name column (Zola-specific phrasing)')
    }

    const sourceIdx = findCol(headers, /^source$/i)
    if (sourceIdx >= 0) {
      const sourceValues = new Set(sampleRows.map((r) => lc(r[sourceIdx])).filter(Boolean))
      const sourceHits = [...sourceValues].filter((v) => ZOLA_SOURCE_VALUES.has(v)).length
      if (sourceHits >= 1) {
        confidence += 15
        evidence.push(`Source column carries Zola values (${sourceHits} matched)`)
      }
    }

    return { confidence: Math.min(100, confidence), evidence }
  },

  mapRow(headers, row): UniversalSignalRow {
    const coupleName = safe(headers, row, /^couple\s*name$/i)
    const { first, last } = splitCoupleName(coupleName)
    const email = safe(headers, row, /^email$/i)
    const inquiredOn = safe(headers, row, /^inquired\s*on$/i)
    const weddingDate = safe(headers, row, /^wedding\s*date$/i)

    return {
      name_raw: coupleName || null,
      first_name: first || null,
      last_initial: last && last.length === 1 ? last : null,
      last_name: last && last.length > 1 ? last : null,
      username: null,
      email: email || null,
      city: null,
      state: null,
      country: null,
      action_class: 'message',
      signal_date: inquiredOn || null,
      source_context: weddingDate
        ? `Inquiry on Zola (wedding date: ${weddingDate})`
        : 'Inquiry on Zola',
      raw_row: Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])),
    }
  },
}
