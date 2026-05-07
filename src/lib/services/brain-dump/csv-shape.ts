/**
 * Brain-dump CSV shape detector.
 *
 * Pure function: given the first row (headers) of a CSV, infer which known
 * shape it maps to and return a canonical column mapping. The API route
 * calls this BEFORE invoking the Claude classifier so:
 *   (a) We short-circuit obvious cases (a clear leads sheet doesn't need
 *       Claude to tell us it's leads)
 *   (b) We pre-warn Claude with a "suspected shape: X" hint so ambiguous
 *       cases still route correctly
 *   (c) We avoid sending thousands of rows into the classifier prompt
 *       (we send headers + 3 sample rows as context only)
 *
 * Shapes recognised (v1):
 *   - knowledge_base_qa  — Question / Answer columns
 *   - knowledge_base_tc  — title / content columns (import from another KB)
 *   - leads              — Name / Email / Wedding Date / Guest Count shape
 *   - tour_links         — Meeting Type / Link columns
 *   - platform_activity  — Action Taken / Visitor Name / Date shape
 *   - reviews            — Rating / Reviewer / Body columns
 *   - marketing_spend    — source / month / amount columns (delegates to
 *                          existing extractSpendFromText in Phase 3)
 *   - unknown            — fall through to the free-text classifier
 *
 * No AI. No DB. Pure string matching — every decision is reviewable in
 * source.
 */

export type CsvShape =
  | 'knowledge_base_qa'
  | 'knowledge_base_tc'
  | 'leads'
  | 'tour_links'
  | 'platform_activity'
  | 'reviews'
  | 'marketing_spend'
  | 'unknown'

export interface ShapeDetection {
  shape: CsvShape
  /**
   * Canonical → source-column mapping. Keys are what downstream routers
   * expect; values are the zero-based column index or column name in the
   * source CSV. Undefined if the optional column was absent.
   */
  columns: Record<string, string | null>
  /** Raw headers exactly as they appeared, lowercase-trimmed for matching. */
  headersNormalised: string[]
  /** How confident we are (heuristic 0-100). Below 60 → fall through to Claude. */
  confidence: number
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function findHeader(headers: string[], candidates: RegExp[]): string | null {
  for (const h of headers) {
    for (const re of candidates) {
      if (re.test(h)) return h
    }
  }
  return null
}

/**
 * Inspect the first row of a CSV and classify its shape.
 */
export function detectCsvShape(headers: readonly string[]): ShapeDetection {
  const norms = headers.map(norm)
  const has = (re: RegExp) => norms.some((h) => re.test(h))
  const col = (re: RegExp) => findHeader(norms, [re])

  // --- knowledge_base_qa: Question + Answer ----------------------------------
  if (has(/^question$/) && has(/^answer$/)) {
    return {
      shape: 'knowledge_base_qa',
      columns: {
        question: 'question',
        answer: 'answer',
        category: col(/^(category|topic|bucket)$/),
      },
      headersNormalised: norms,
      confidence: 95,
    }
  }

  // --- knowledge_base_tc: title + content (KB export from another system) ---
  if (has(/^title$/) && has(/^content$/)) {
    return {
      shape: 'knowledge_base_tc',
      columns: {
        question: 'title',
        answer: 'content',
        category: col(/^(subcategory|category|topic)$/),
        is_active: col(/^(active|is_active|enabled)$/),
      },
      headersNormalised: norms,
      confidence: 90,
    }
  }

  // --- tour_links: Meeting Type + Link ---------------------------------------
  if (has(/^(meeting type|tour type|type|label)$/) && has(/^(link|url|calendly)$/)) {
    return {
      shape: 'tour_links',
      columns: {
        label: col(/^(meeting type|tour type|type|label)$/),
        url: col(/^(link|url|calendly)$/),
        audience: col(/^(audience|for|who)$/),
        description: col(/^(description|notes|detail)$/),
      },
      headersNormalised: norms,
      confidence: 92,
    }
  }

  // --- platform_activity: Action Taken + Visitor Name + Date ----------------
  if (
    has(/^(action|action taken|event|activity)$/) &&
    has(/^(visitor|visitor name|user|from)$/) &&
    has(/^(date|date of visit|visit date)$/)
  ) {
    return {
      shape: 'platform_activity',
      columns: {
        action: col(/^(action|action taken|event|activity)$/),
        visitor: col(/^(visitor|visitor name|user|from)$/),
        date: col(/^(date|date of visit|visit date)$/),
        city: col(/^city$/),
        state: col(/^state$/),
      },
      headersNormalised: norms,
      confidence: 90,
    }
  }

  // --- reviews: Rating + Reviewer + Body -------------------------------------
  if (
    has(/^(rating|stars)$/) &&
    has(/^(reviewer|reviewer name|by|name)$/) &&
    has(/^(body|review|review text|text|comment)$/)
  ) {
    return {
      shape: 'reviews',
      columns: {
        rating: col(/^(rating|stars)$/),
        reviewer: col(/^(reviewer|reviewer name|by|name)$/),
        body: col(/^(body|review|review text|text|comment)$/),
        date: col(/^(date|review date|posted)$/),
        source: col(/^(source|platform|site)$/),
        title: col(/^(title|subject|heading)$/),
      },
      headersNormalised: norms,
      confidence: 88,
    }
  }

  // --- leads: Name + Email + (Wedding Date or Guest Count) ------------------
  // Heuristic: any of the many name/email/wedding-date labels common in
  // coordinator CRM sheets. Confidence trimmed if only partial match.
  const hasNameish = has(/name$/) || has(/^client|^partner|^couple/)
  const hasEmail = has(/email/)
  const hasWedDate = has(/wedding date|event date/)
  const hasGuests = has(/guest|headcount/)
  const hasSource = has(/(heard about|source|referral)/)
  if (hasNameish && hasEmail && (hasWedDate || hasGuests || hasSource)) {
    return {
      shape: 'leads',
      columns: {
        client_name: col(/^(client full name|client name|name|full name)$/),
        partner_name: col(/^(partner full name|partner name|partner|fiance)$/),
        email_1: col(/^(email|email one|email 1|primary email)$/),
        email_2: col(/^email two|email 2|secondary email$/),
        email_3: col(/^email three|email 3$/),
        email_4: col(/^email four|email 4$/),
        first_contact: col(/^(date of first contact|first contact|inquiry date|contacted)$/),
        wedding_date: col(/^(wedding date|event date)$/),
        guests: col(/^(number of guests|guest count|guests|headcount)$/),
        source: col(/^(where did they hear about us|heard about us|source|referral source)$/),
        notes: col(/^(other notes|notes|detail|comment)$/),
        faq_questions: col(/^(questions to add to faq|faq|questions)$/),
      },
      headersNormalised: norms,
      confidence: hasWedDate && hasGuests ? 90 : 70,
    }
  }

  // --- marketing_spend: source/platform + month/period + amount -------------
  const hasPlatform = has(/^(source|platform|channel)$/)
  const hasPeriod = has(/^(month|period|date)$/)
  const hasAmount = has(/^(amount|spend|cost|total)$/)
  if (hasPlatform && hasPeriod && hasAmount) {
    return {
      shape: 'marketing_spend',
      columns: {
        source: col(/^(source|platform|channel)$/),
        period: col(/^(month|period|date)$/),
        amount: col(/^(amount|spend|cost|total)$/),
      },
      headersNormalised: norms,
      confidence: 88,
    }
  }

  return { shape: 'unknown', columns: {}, headersNormalised: norms, confidence: 0 }
}

/**
 * Lightweight CSV parser that handles quoted fields with embedded commas
 * and embedded quotes ("") — enough for the shape-detection + small-sample
 * preview paths. Not a replacement for a streaming parser on huge files.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let i = 0
  let field = ''
  let row: string[] = []
  let inQuotes = false
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue }
      if (c === '"') { inQuotes = false; i++; continue }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim().length))
}

/**
 * Build a canonical { column_key: value } row given the shape detection
 * + a single CSV data row.
 */
export function rowToRecord(
  detection: ShapeDetection,
  headerRow: string[],
  dataRow: string[]
): Record<string, string | null> {
  const norms = headerRow.map(norm)
  const headerIdx: Record<string, number> = {}
  norms.forEach((h, i) => { headerIdx[h] = i })

  const out: Record<string, string | null> = {}
  for (const [key, src] of Object.entries(detection.columns)) {
    if (!src) { out[key] = null; continue }
    const idx = headerIdx[src]
    const raw = idx != null ? (dataRow[idx] ?? '') : ''
    out[key] = raw.trim() || null
  }
  return out
}
