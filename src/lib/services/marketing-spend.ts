/**
 * Bloom House: Marketing Spend Importer
 *
 * Phase 3 Task 33. One service, four input channels:
 *   1. Manual form entry — coordinator types a row per month per source.
 *   2. CSV upload — paste a Google Ads / Facebook / WeddingWire export.
 *   3. Screenshot (future) — OCR-extracted text passed in as a rawText
 *      blob; the classifier + LLM summariser produce rows.
 *   4. Brain-dump "analytics" intent — routeBrainDump calls
 *      importSpendFromText() with the coordinator's raw note.
 *
 * All four land in the same `marketing_spend` table through
 * `upsertSpendRows()`. Dedup key: (venue_id, source, month) — a second
 * upload for the same month overrides the prior amount.
 *
 * Multi-venue: every write scoped by the venueId argument. Platforms are
 * free-text so UK venues can enter Hitched / Bridebook without schema
 * changes.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'

export interface SpendRow {
  source: string
  month: string // YYYY-MM-01 — first of the spend month
  amount: number
  notes?: string | null
  campaign?: string | null
}

export interface ImportResult {
  inserted: number
  updated: number
  skipped: number
  rows: SpendRow[]
  errors: string[]
}

/**
 * Upsert spend rows. Month is coerced to first-of-month. Zero-amount
 * rows are dropped (a coordinator typing 0 almost always meant "don't
 * record this" — they can delete the row instead).
 */
export async function upsertSpendRows(args: {
  venueId: string
  rows: SpendRow[]
}): Promise<ImportResult> {
  const { venueId, rows } = args
  const supabase = createServiceClient()
  const result: ImportResult = { inserted: 0, updated: 0, skipped: 0, rows: [], errors: [] }

  for (const row of rows) {
    // Normalise month to YYYY-MM-01 for dedup.
    const normalisedMonth = normaliseMonth(row.month)
    if (!normalisedMonth) {
      result.skipped++
      result.errors.push(`invalid month: ${row.month}`)
      continue
    }
    if (!row.source || !row.source.trim()) {
      result.skipped++
      result.errors.push('missing source')
      continue
    }
    if (!Number.isFinite(row.amount) || row.amount <= 0) {
      result.skipped++
      continue
    }

    const payload = {
      venue_id: venueId,
      source: row.source.trim().toLowerCase().replace(/\s+/g, '_'),
      month: normalisedMonth,
      amount: row.amount,
      notes: row.notes ?? row.campaign ?? null,
    }

    // Check if a row exists for dedup.
    const { data: existing } = await supabase
      .from('marketing_spend')
      .select('id')
      .eq('venue_id', venueId)
      .eq('source', payload.source)
      .eq('month', payload.month)
      .maybeSingle()

    if (existing) {
      const { error } = await supabase
        .from('marketing_spend')
        .update({ amount: payload.amount, notes: payload.notes })
        .eq('id', existing.id)
      if (error) {
        result.errors.push(`update ${payload.source}/${payload.month}: ${error.message}`)
        result.skipped++
      } else {
        result.updated++
        result.rows.push({ ...row, month: normalisedMonth })
      }
    } else {
      const { error } = await supabase.from('marketing_spend').insert(payload)
      if (error) {
        result.errors.push(`insert ${payload.source}/${payload.month}: ${error.message}`)
        result.skipped++
      } else {
        result.inserted++
        result.rows.push({ ...row, month: normalisedMonth })
      }
    }
  }

  return result
}

/**
 * CSV import. Accepts column headers in any case / any order as long as
 * they include variants of "source|platform|channel", "month|date|period",
 * "amount|spend|cost|total".
 */
export function parseSpendCsv(csv: string): { rows: SpendRow[]; errors: string[] } {
  const errors: string[] = []
  const rows: SpendRow[] = []
  const lines = csv
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 2) {
    return { rows, errors: ['csv must have a header row and at least one data row'] }
  }

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const sourceIdx = headers.findIndex((h) => /source|platform|channel/.test(h))
  const monthIdx = headers.findIndex((h) => /month|date|period/.test(h))
  const amountIdx = headers.findIndex((h) => /amount|spend|cost|total/.test(h))
  const campaignIdx = headers.findIndex((h) => /campaign/.test(h))

  if (sourceIdx === -1 || monthIdx === -1 || amountIdx === -1) {
    return {
      rows,
      errors: [
        `CSV header must include source (or platform/channel), month (or date/period), and amount (or spend/cost/total). Got: ${headers.join(', ')}`,
      ],
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvRow(lines[i])
    if (cells.length <= Math.max(sourceIdx, monthIdx, amountIdx)) {
      errors.push(`row ${i + 1}: not enough columns`)
      continue
    }
    const source = cells[sourceIdx]?.trim()
    const month = cells[monthIdx]?.trim()
    const amountStr = cells[amountIdx]?.trim().replace(/[$,£€]/g, '').replace(/,/g, '')
    const amount = Number(amountStr)
    const campaign = campaignIdx >= 0 ? cells[campaignIdx]?.trim() : undefined
    if (!source || !month || !Number.isFinite(amount)) {
      errors.push(`row ${i + 1}: parse error (source=${source}, month=${month}, amount=${amountStr})`)
      continue
    }
    rows.push({ source, month, amount, campaign })
  }

  return { rows, errors }
}

/**
 * Free-text import. Asks Claude to extract spend rows from a paragraph
 * or brain-dump note. Returns best-effort — always check result.errors.
 */
export async function extractSpendFromText(args: {
  venueId: string
  text: string
}): Promise<{ rows: SpendRow[]; errors: string[] }> {
  const { venueId, text } = args
  if (!text || text.trim().length === 0) return { rows: [], errors: ['empty text'] }

  try {
    const parsed = await callAIJson<{ rows?: Array<{ source?: string; month?: string; amount?: number; campaign?: string }> }>({
      systemPrompt: `Extract marketing spend entries from free-text notes. Output JSON shape:
{ "rows": [{ "source": string, "month": "YYYY-MM-01", "amount": number, "campaign": string | null }] }

Rules:
- One row per (source, month) pair.
- "source" should be a lowercase snake_case platform identifier (the_knot, wedding_wire, instagram, google_ads, facebook, tiktok, zola, etc). Infer from context.
- "month" must be YYYY-MM-01 format — the first of the spend month.
- "amount" in USD (or whatever the user's currency is) — strip currency symbols.
- If the text doesn't contain parseable spend data, return { "rows": [] }.
- Do not invent numbers. Leave a row out if any of source/month/amount is uncertain.`,
      userPrompt: `Text: """${text}"""

Extract any marketing spend references. Respond with JSON only.`,
      venueId,
      taskType: 'spend_extraction',
      maxTokens: 600,
    })
    const candidates = Array.isArray(parsed.rows) ? parsed.rows : []
    const rows: SpendRow[] = []
    for (const r of candidates) {
      if (
        r &&
        typeof r.source === 'string' &&
        typeof r.month === 'string' &&
        typeof r.amount === 'number'
      ) {
        rows.push({
          source: r.source,
          month: r.month,
          amount: r.amount,
          campaign: typeof r.campaign === 'string' ? r.campaign : null,
        })
      }
    }
    return { rows, errors: rows.length === 0 ? ['no spend rows detected in text'] : [] }
  } catch (err) {
    return {
      rows: [],
      errors: [err instanceof Error ? err.message : String(err)],
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseMonth(input: string): string | null {
  if (!input) return null
  // YYYY-MM-01 already.
  if (/^\d{4}-\d{2}-01$/.test(input)) return input
  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(input)) return `${input}-01`
  // MM/YYYY
  const slashMatch = input.match(/^(\d{1,2})\/(\d{4})$/)
  if (slashMatch) {
    const [, m, y] = slashMatch
    return `${y}-${m.padStart(2, '0')}-01`
  }
  // "January 2026"
  const d = new Date(input)
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    return `${y}-${m}-01`
  }
  return null
}

/**
 * Very small CSV row splitter: handles quoted fields with commas but
 * not escaped quotes inside quotes. Sufficient for the platform exports
 * we know about (Google Ads, Facebook, WeddingWire, spreadsheet paste).
 */
function splitCsvRow(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      inQuote = !inQuote
      continue
    }
    if (c === ',' && !inQuote) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
}
