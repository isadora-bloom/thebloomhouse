/**
 * Canonical-packages extraction (T5-Rixey-HH).
 *
 * Many venues encode their pricing structure IN the form they expose
 * to couples — package tiers, upgrade add-ons, discounts. The form
 * IS the catalog. Rixey's calculator is a great example: every season
 * has a price, every upgrade is a "$NAME (CONDITIONS): $PRICE" string,
 * every discount is "NAME: PERCENT".
 *
 * extractPackagesFromFormSchema() walks the form's columns + values
 * once (during onboarding) and proposes packages rows for the
 * coordinator to confirm. Confirmed rows feed Sage's pricing-context
 * loader, the temporal-trigger booking-value resolver, and (future)
 * pricing-history reconciliation.
 *
 * The extractor is parser-driven not LLM-driven — these strings have
 * predictable shapes, an LLM call would be expensive overkill, and
 * the coordinator is going to confirm every proposal anyway.
 *
 * Rixey-shape patterns supported (which generalise OK to similar
 * concatenated-multi-select form columns):
 *
 *   1. Package tiers — single value per row (Wedding Season column):
 *        "Spring: $12000"  /  "Summer: $10000"  /  "Fall 2025: $14000"
 *      Each unique value becomes one ProposedPackage of kind='package'.
 *
 *   2. Upgrades — concatenated " + " separated multi-select (Upgrades column):
 *        "Rehearsal Dinner on Site (50-100 guests, max 4 hours): $2000
 *         + Extra Hour of Wedding Party (event must finish a 11pm): $750"
 *      Each segment becomes one ProposedPackage of kind='upgrade'.
 *
 *   3. Discounts — concatenated " + " separated multi-select (Discounts col):
 *        "Couple Military/Veteran/Front Line Responders: 10
 *         + Only Using Recommended Vendors: 5"
 *      Each segment becomes one ProposedPackage of kind='discount' with
 *      discount_percent = the trailing integer.
 *
 *   4. Stay-night packages — single value (How Many Nights Stay column):
 *        "One Night: 1750"  /  "Two Night: 3250"  /  "No Nights: 0"
 *      Becomes kind='upgrade' (closer in spirit to add-on than to base
 *      package).
 *
 * The output is a list of de-duplicated ProposedPackage rows with
 * status='proposed'. INSERT happens at the /onboarding/extract-packages
 * confirmation step.
 */

import { parseCsvRows } from '@/lib/services/brain-dump-csv-shape'
import type { FormHint } from './web-form'

export interface ProposedPackage {
  kind: 'package' | 'upgrade' | 'discount' | 'fee'
  name: string
  season?: string | null
  tier?: string | null
  guest_count_min?: number | null
  guest_count_max?: number | null
  price_cents?: number | null
  discount_percent?: number | null
  source_text: string
  /** Provenance: which hint column this came from. */
  source_column: string
  /** How many submitted rows had this exact value selected. Useful for
   *  the coordinator to see "this was picked 38 times" in the confirm UI. */
  occurrences: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "12,000" / "$12,000" / "12000.00" → 1200000 cents. NULL on parse fail. */
function moneyToCents(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const cleaned = String(raw).replace(/[$,\s]/g, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** "Spring 2026" / "Spring : $12000" / "Summer" → 'spring' | 'summer' | etc. */
function detectSeason(label: string): string | null {
  const ll = label.toLowerCase()
  if (/\bspring\b/.test(ll))  return 'spring'
  if (/\bsummer\b/.test(ll))  return 'summer'
  if (/\bfall|autumn\b/.test(ll)) return 'fall'
  if (/\bwinter\b/.test(ll))  return 'winter'
  return null
}

/** "(50-100 guests, max 4 hours)" → { min: 50, max: 100 }. */
function detectGuestBand(label: string): { min: number | null; max: number | null } {
  const m = label.match(/(\d+)\s*[-–]\s*(\d+)\s*guests?/i)
  if (!m) return { min: null, max: null }
  return { min: Number(m[1]), max: Number(m[2]) }
}

/** Clean a raw label by stripping the trailing pricing tag.
 *  "Rehearsal Dinner on Site (50-100 guests, max 4 hours): $2000" →
 *  "Rehearsal Dinner on Site (50-100 guests, max 4 hours)". */
function stripPricing(raw: string): string {
  return raw.replace(/:\s*\$?\d[\d,.]*\s*$/, '').trim()
}

/** Pull "$2000" / "2000" / ": 10" → 2000. */
function trailingNumber(raw: string): number | null {
  const m = raw.match(/:\s*\$?(\d[\d,]*\.?\d*)\s*$/)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Per-cell parsers. Each handles one *type* of form column.
// ---------------------------------------------------------------------------

/** Parses a "single value per row" column into one canonical proposal.
 *  e.g. "Spring 2026: $12000" → { kind: 'package', name: 'Spring 2026',
 *  season: 'spring', price_cents: 1200000 }. */
function parsePackageCell(raw: string, columnHeader: string): ProposedPackage | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '0' || trimmed === '...') return null
  const cents = trailingNumber(trimmed)
  const name = stripPricing(trimmed) || trimmed
  return {
    kind: 'package',
    name,
    season: detectSeason(name),
    price_cents: cents != null ? cents * 100 : null,
    source_text: trimmed,
    source_column: columnHeader,
    occurrences: 1,
  }
}

/** Parses a " + "-separated multi-select cell into N upgrade proposals. */
function parseUpgradeCell(raw: string, columnHeader: string): ProposedPackage[] {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '0' || trimmed === '...') return []
  return trimmed.split(/\s+\+\s+/).flatMap((segment) => {
    const seg = segment.trim()
    if (!seg) return []
    // Skip "Normal Wedding Package As Selected Above: 0" which Rixey emits
    // as a no-op echo of the package above.
    if (/^normal wedding package/i.test(seg)) return []
    // Skip cells that are obviously a no-op (": 0").
    const cents = trailingNumber(seg)
    const name = stripPricing(seg) || seg
    if (cents === 0 || cents == null) return []
    const band = detectGuestBand(name)
    return [{
      kind: 'upgrade' as const,
      name,
      guest_count_min: band.min,
      guest_count_max: band.max,
      price_cents: cents * 100,
      source_text: seg,
      source_column: columnHeader,
      occurrences: 1,
    }]
  })
}

/** Parses a " + "-separated discount cell. Discounts express percent
 *  values as trailing integers (no $ sign): "Military: 10". */
function parseDiscountCell(raw: string, columnHeader: string): ProposedPackage[] {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '0' || trimmed === '...') return []
  return trimmed.split(/\s+\+\s+/).flatMap((segment) => {
    const seg = segment.trim()
    if (!seg) return []
    const num = trailingNumber(seg)
    if (num == null || num === 0) return []
    const name = stripPricing(seg) || seg
    return [{
      kind: 'discount' as const,
      name,
      discount_percent: num <= 100 ? Math.round(num) : null,
      source_text: seg,
      source_column: columnHeader,
      occurrences: 1,
    }]
  })
}

// ---------------------------------------------------------------------------
// Top-level extractor.
// ---------------------------------------------------------------------------

export interface ExtractResult {
  proposals: ProposedPackage[]
  warnings: string[]
}

export function extractPackagesFromFormSchema(args: {
  csvText: string
  hint: FormHint
}): ExtractResult {
  const warnings: string[] = []
  const csvRows = parseCsvRows(args.csvText)
  if (csvRows.length < 2) {
    return { proposals: [], warnings: ['csv must have a header row and at least one data row'] }
  }

  const header = csvRows[0]
  const headerByLower = new Map<string, number>()
  header.forEach((h, i) => headerByLower.set(h.trim().toLowerCase(), i))

  function findIdx(name: string): number {
    return headerByLower.get(name.trim().toLowerCase()) ?? -1
  }

  // Aggregate proposals by a stable key so duplicates merge into one
  // entry with occurrences++.
  const accum = new Map<string, ProposedPackage>()
  function add(p: ProposedPackage | null | undefined) {
    if (!p) return
    const key = `${p.kind}|${p.name.toLowerCase()}|${p.season ?? ''}|${p.guest_count_min ?? ''}|${p.guest_count_max ?? ''}`
    const existing = accum.get(key)
    if (existing) {
      existing.occurrences += 1
    } else {
      accum.set(key, { ...p })
    }
  }

  // Walk every data row, every configured column.
  const packageCols = (args.hint.packageColumns ?? []).map((c) => ({ name: c, idx: findIdx(c) })).filter((c) => c.idx >= 0)
  const upgradeCols = (args.hint.upgradeColumns ?? []).map((c) => ({ name: c, idx: findIdx(c) })).filter((c) => c.idx >= 0)
  const discountCols = (args.hint.discountColumns ?? []).map((c) => ({ name: c, idx: findIdx(c) })).filter((c) => c.idx >= 0)

  if (packageCols.length === 0 && upgradeCols.length === 0 && discountCols.length === 0) {
    warnings.push(
      'No package / upgrade / discount columns configured on this hint. Edit the hint or pick a different provider.',
    )
    return { proposals: [], warnings }
  }

  for (let r = 1; r < csvRows.length; r++) {
    const row = csvRows[r]
    for (const col of packageCols) {
      const raw = (row[col.idx] ?? '').trim()
      if (raw && raw !== '...') add(parsePackageCell(raw, col.name))
    }
    for (const col of upgradeCols) {
      const raw = (row[col.idx] ?? '').trim()
      if (raw && raw !== '...') parseUpgradeCell(raw, col.name).forEach(add)
    }
    for (const col of discountCols) {
      const raw = (row[col.idx] ?? '').trim()
      if (raw && raw !== '...') parseDiscountCell(raw, col.name).forEach(add)
    }
  }

  const proposals = Array.from(accum.values())
    .sort((a, b) => {
      // Group by kind first (package, upgrade, discount, fee), then
      // descending by occurrences (most-popular first).
      const kindOrder: Record<string, number> = { package: 0, upgrade: 1, discount: 2, fee: 3 }
      const ka = kindOrder[a.kind] ?? 99
      const kb = kindOrder[b.kind] ?? 99
      if (ka !== kb) return ka - kb
      return b.occurrences - a.occurrences
    })

  if (proposals.length === 0) {
    warnings.push('No package / upgrade / discount values found in the supplied CSV.')
  }

  return { proposals, warnings }
}
