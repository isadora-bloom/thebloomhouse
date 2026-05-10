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
 * Shapes recognised:
 *   Adapter shapes (Wave 4 Phase 4c — most-specific, route through the
 *   crm-import unified router so the actual provider adapter runs):
 *   - honeybook            — Project Name / Project Date / Client Email
 *   - aisleplanner         — Couple / Wedding Date + Aisle-Planner ID hint
 *   - dubsado              — Project Name / Client First Name / Client Last
 *   - tour_scheduler       — Event Type Name / Start Date & Time / Invitee
 *   - web_form             — Reference Number / Partner One Name (Rixey
 *                            calculator) or Submitted At / Network ID
 *                            (Typeform) etc.
 *
 *   Generic shapes (existing brain-dump v1):
 *   - knowledge_base_qa    — Question / Answer columns
 *   - knowledge_base_tc    — title / content columns (import from another KB)
 *   - leads                — Name / Email / Wedding Date / Guest Count shape
 *   - tour_links           — Meeting Type / Link columns
 *   - platform_activity    — Action Taken / Visitor Name / Date shape
 *   - reviews              — Rating / Reviewer / Body columns
 *   - marketing_spend      — source / month / amount columns
 *   - unknown              — fall through to the free-text classifier
 *
 * Detection priority:
 *   adapter shapes (most-specific) → leads → tour_links → reviews →
 *   platform_activity → marketing_spend → knowledge_base_* → unknown.
 *
 * Why adapter shapes go first:
 *   The HoneyBook misroute that triggered Wave 4 Phase 4c was caused by
 *   a HoneyBook export's headers overlapping enough with the
 *   platform_activity heuristic that the wrong importer fired. The fix
 *   is order-of-evaluation: check adapter shapes (which look at multiple
 *   provider-canonical columns) before the looser generic-shape rules.
 *
 * No AI. No DB. Pure string matching — every decision is reviewable in
 * source.
 */

export type CsvShape =
  // Adapter shapes — Wave 4 Phase 4c.
  | 'honeybook'
  | 'aisleplanner'
  | 'dubsado'
  | 'tour_scheduler'
  | 'web_form'
  | 'web_form_packages'
  // Generic shapes — pre-existing brain-dump v1.
  | 'knowledge_base_qa'
  | 'knowledge_base_tc'
  | 'leads'
  | 'tour_links'
  | 'platform_activity'
  | 'reviews'
  | 'marketing_spend'
  | 'unknown'

/**
 * Adapter shapes — the subset that maps to a CRM-import adapter and
 * therefore should route through the unified import-router (Wave 4
 * Phase 4c), NOT through brain-dump's legacy importLeads /
 * importPlatformSignals path.
 */
export const ADAPTER_SHAPES: ReadonlySet<CsvShape> = new Set<CsvShape>([
  'honeybook',
  'aisleplanner',
  'dubsado',
  'tour_scheduler',
  'web_form',
  'web_form_packages',
])

export function isAdapterShape(shape: CsvShape): boolean {
  return ADAPTER_SHAPES.has(shape)
}

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
 * Count how many of the supplied predicates match against the headers.
 * Used by adapter detectors to require N-of-M canonical columns before
 * declaring a shape.
 */
function countMatches(norms: string[], predicates: RegExp[]): number {
  let n = 0
  for (const re of predicates) {
    if (norms.some((h) => re.test(h))) n++
  }
  return n
}

/**
 * Inspect the first row of a CSV and classify its shape.
 *
 * Detection order (Wave 4 Phase 4c, 2026-05-09):
 *   1. Adapter shapes (honeybook / aisleplanner / dubsado / tour_scheduler /
 *      web_form / web_form_packages) — checked FIRST because their
 *      multi-column signatures are more specific than the legacy
 *      generic shapes. Misrouting a HoneyBook export through
 *      platform_activity is what motivated this whole pass.
 *   2. Generic structural shapes (knowledge_base_qa, knowledge_base_tc,
 *      tour_links, reviews) — these have very narrow header signatures
 *      and rarely conflict.
 *   3. platform_activity — has the loosest header heuristic, runs after
 *      adapters so a HoneyBook / Aisleplanner export can't misroute here.
 *   4. leads — generic CRM-shaped fallback (Name / Email / Wedding Date /
 *      Guest Count). Runs after the named adapters so a more-specific
 *      match wins.
 *   5. marketing_spend — narrow header signature, last because of low
 *      header overlap with adapter exports.
 */
export function detectCsvShape(headers: readonly string[]): ShapeDetection {
  const norms = headers.map(norm)
  const has = (re: RegExp) => norms.some((h) => re.test(h))
  const col = (re: RegExp) => findHeader(norms, [re])

  // --- ADAPTER SHAPES (Wave 4 Phase 4c) -------------------------------------
  // These run BEFORE the generic shapes so a HoneyBook / Aisleplanner /
  // Dubsado / tour-scheduler / web-form export with overlapping columns
  // doesn't get mis-routed to platform_activity / leads.

  // --- honeybook ------------------------------------------------------------
  // Canonical HoneyBook export (Settings → Reports → Projects → Export):
  //   Project Name, Project Date, Client Email (REQUIRED)
  //   Project Status, Total, Source, Inquiry Date, Booking Date,
  //   Client Name, Client Phone, Tags, Notes (OPTIONAL)
  // Column-name regexes mirror src/lib/services/crm-import/honeybook.ts COLUMNS.
  //
  // Disambiguation against Dubsado: HoneyBook uses a single "Client Name"
  // column; Dubsado splits into "Client First Name" + "Client Last Name".
  // When both split-name columns are present, defer to the Dubsado branch
  // below so the right adapter runs.
  if (!(has(/^client\s*first\s*name$/) && has(/^client\s*last\s*name$/))) {
    const hbStrong = [
      /^project\s*name$/,
      /^(project\s*date|event\s*date|wedding\s*date|date)$/,
      /^(client\s*email|email|primary\s*email)$/,
    ]
    const hbWeak = [
      /^(project\s*status|status|lead\s*status)$/,
      /^(total|total\s*project\s*cost|project\s*value|total\s*invoiced)$/,
      /^(source|lead\s*source|how\s*did\s*you\s*hear)$/,
      /^(inquiry\s*date|created\s*date|created|date\s*created)$/,
      /^(booking\s*date|booked\s*date|date\s*booked|contract\s*signed\s*date)$/,
      /^(client\s*name|primary\s*client(\s*name)?)$/,
      /^(client\s*phone|phone|primary\s*phone)$/,
      /^tags$/,
    ]
    const strong = countMatches(norms, hbStrong)
    const weak = countMatches(norms, hbWeak)
    // Require at least 2 of 3 strong AND at least 2 weak signals — that's
    // enough to disambiguate from a generic leads CSV.
    if (strong >= 2 && weak >= 2) {
      // Confidence scoring: 4+ canonical adapter columns matched → 95+;
      // 2-3 → 60-80 (flag for operator review).
      const total = strong + weak
      const confidence = total >= 6 ? 95 : total >= 4 ? 85 : 70
      return {
        shape: 'honeybook',
        columns: {
          project_name: col(/^project\s*name$/),
          project_date: col(/^(project\s*date|event\s*date|wedding\s*date|date)$/),
          project_status: col(/^(project\s*status|status|lead\s*status)$/),
          client_name: col(/^(client\s*name|primary\s*client(\s*name)?)$/),
          client_email: col(/^(client\s*email|email|primary\s*email)$/),
          client_phone: col(/^(client\s*phone|phone|primary\s*phone)$/),
          total: col(/^(total|total\s*project\s*cost|project\s*value|total\s*invoiced)$/),
          source: col(/^(source|lead\s*source|how\s*did\s*you\s*hear)$/),
          inquiry_date: col(/^(inquiry\s*date|created\s*date|created|date\s*created)$/),
          booking_date: col(/^(booking\s*date|booked\s*date|date\s*booked|contract\s*signed\s*date)$/),
          tags: col(/^tags$/),
          notes: col(/^(notes|internal\s*notes|description)$/),
        },
        headersNormalised: norms,
        confidence,
      }
    }
  }

  // --- aisleplanner ---------------------------------------------------------
  // Aisle Planner exports have a "Couple" column (single string with
  // both partner names) plus a "Lead ID" / "Estimated Budget" /
  // "Booked Date" combination that's distinctive.
  {
    const apStrong = [
      /^couple$/,
      /^(wedding\s*date|event\s*date)$/,
      /^(email\s*address|email)$/,
    ]
    const apWeak = [
      /^lead\s*id$/,
      /^estimated\s*budget$/,
      /^booked\s*date$/,
      /^status$/,
      /^(created|date\s*created)$/,
    ]
    const strong = countMatches(norms, apStrong)
    const weak = countMatches(norms, apWeak)
    // Aisle Planner's "Couple" header is almost unique — paired with
    // any one weak signal it's safe to route there.
    if (has(/^couple$/) && strong >= 2 && weak >= 1) {
      const total = strong + weak
      const confidence = total >= 5 ? 95 : 80
      return {
        shape: 'aisleplanner',
        columns: {
          source_id: col(/^lead\s*id$/),
          couple: col(/^couple$/),
          email: col(/^(email\s*address|email)$/),
          phone: col(/^phone$/),
          wedding_date: col(/^(wedding\s*date|event\s*date)$/),
          estimated_budget: col(/^estimated\s*budget$/),
          status: col(/^status$/),
          source: col(/^source$/),
          created: col(/^(created|date\s*created)$/),
          booked_date: col(/^booked\s*date$/),
          notes: col(/^notes$/),
        },
        headersNormalised: norms,
        confidence,
      }
    }
  }

  // --- dubsado --------------------------------------------------------------
  // Dubsado split-name export ("Client First Name" + "Client Last Name") is
  // the canonical signature. HoneyBook's "Client Name" is a single column.
  {
    const dbStrong = [
      /^client\s*first\s*name$/,
      /^client\s*last\s*name$/,
      /^(project\s*name|client\s*email)$/,
    ]
    const dbWeak = [
      /^project\s*date$/,
      /^total\s*invoiced$/,
      /^project\s*status$/,
      /^lead\s*source$/,
      /^date\s*created$/,
      /^date\s*booked$/,
      /^contract\s*signed\s*date$/,
      /^internal\s*notes$/,
    ]
    const strong = countMatches(norms, dbStrong)
    const weak = countMatches(norms, dbWeak)
    // Require split-first/last + one strong + at least one weak.
    if (
      has(/^client\s*first\s*name$/) &&
      has(/^client\s*last\s*name$/) &&
      strong >= 2 &&
      weak >= 1
    ) {
      const total = strong + weak
      const confidence = total >= 5 ? 95 : 80
      return {
        shape: 'dubsado',
        columns: {
          project_name: col(/^project\s*name$/),
          client_first: col(/^client\s*first\s*name$/),
          client_last: col(/^client\s*last\s*name$/),
          client_email: col(/^client\s*email$/),
          client_phone: col(/^client\s*phone$/),
          project_date: col(/^project\s*date$/),
          total_invoiced: col(/^total\s*invoiced$/),
          project_status: col(/^project\s*status$/),
          lead_source: col(/^lead\s*source$/),
          date_created: col(/^date\s*created$/),
          date_booked: col(/^(date\s*booked|contract\s*signed\s*date)$/),
          internal_notes: col(/^internal\s*notes$/),
        },
        headersNormalised: norms,
        confidence,
      }
    }
  }

  // --- tour_scheduler -------------------------------------------------------
  // Calendly export (validated against Rixey 2025-05 → 2026-05). The
  // adapter's CAL_REQUIRED is exactly: 'Event Type Name', 'Start Date &
  // Time', 'Invitee Email'. We add the optional weak signals so partial
  // exports also match.
  {
    const tsStrong = [
      /^event\s*type\s*name$/,
      /^start\s*date\s*&\s*time$/,
      /^invitee\s*email$/,
    ]
    const tsWeak = [
      /^invitee\s*name$/,
      /^cancel(led|lation)\s*reason$/,
      /^utm[\s_-]*source$/,
      /^question\s*\d+$/,
      /^response\s*\d+$/,
      /^location$/,
    ]
    const strong = countMatches(norms, tsStrong)
    const weak = countMatches(norms, tsWeak)
    // 'Event Type Name' is virtually unique to Calendly — when it
    // appears with at least one other Calendly canonical column we
    // route to the tour-scheduler adapter.
    if (has(/^event\s*type\s*name$/) && strong >= 2) {
      const total = strong + weak
      const confidence = total >= 5 ? 95 : strong === 3 ? 88 : 70
      return {
        shape: 'tour_scheduler',
        columns: {
          event_type_name: col(/^event\s*type\s*name$/),
          start_at: col(/^start\s*date\s*&\s*time$/),
          end_at: col(/^end\s*date\s*&\s*time$/),
          invitee_name: col(/^invitee\s*name$/),
          invitee_email: col(/^invitee\s*email$/),
          cancel_reason: col(/^cancel(led|lation)\s*reason$/),
          utm_source: col(/^utm[\s_-]*source$/),
          location: col(/^location$/),
        },
        headersNormalised: norms,
        confidence,
      }
    }
  }

  // --- web_form_packages ----------------------------------------------------
  // Rixey-style pricing-calculator exports include packageColumns +
  // upgrade columns + a calculated total — when the columns include
  // calculator-output fields ("After Tax" / "Total Before Discounts"),
  // routing to web-form-packages preserves the pricing structure.
  {
    const pkgStrong = [
      /^after\s*tax$/,
      /^total\s*before\s*discounts$/,
      /^each\s*payment$/,
    ]
    const pkgWeak = [
      /^reference\s*number$/,
      /^received$/,
      /^partner\s*one\s*name$/,
      /^partner\s*two\s*name$/,
      /^wedding\s*season/,
      /^upgrades$/,
      /^(discounts|percentage).*$/,
    ]
    const strong = countMatches(norms, pkgStrong)
    const weak = countMatches(norms, pkgWeak)
    if (strong >= 2 && weak >= 2) {
      const total = strong + weak
      const confidence = total >= 6 ? 92 : 78
      return {
        shape: 'web_form_packages',
        columns: {
          reference: col(/^reference\s*number$/),
          received: col(/^received$/),
          partner1_name: col(/^partner\s*one\s*name$/),
          partner1_email: col(/^partner\s*one\s*email$/),
          partner2_name: col(/^partner\s*two\s*name$/),
          partner2_email: col(/^partner\s*two\s*email$/),
          after_tax: col(/^after\s*tax$/),
          before_discounts: col(/^total\s*before\s*discounts$/),
        },
        headersNormalised: norms,
        confidence,
      }
    }
  }

  // --- web_form -------------------------------------------------------------
  // Generic form shapes: Typeform / Jotform / Google Forms / custom.
  // Signature: a submission timestamp column ("Submitted At" / "Submission
  // Date" / "Timestamp" / "Received") + at least one identity column
  // (Email / Phone) + a wedding/event field. Distinct from the leads
  // shape because the timestamp column is form-specific (not "Created
  // Date" / "Inquiry Date" which CRMs use).
  {
    const wfTimestamp = [
      /^submitted\s*at$/,
      /^submission\s*date$/,
      /^timestamp$/,
      /^received$/,
      /^submission\s*id$/,
      /^network\s*id$/,
    ]
    const wfIdentity = [
      /^(email|email\s*address|your\s*email)$/,
      /^(phone(\s*number)?|your\s*phone)$/,
      /^(name|your\s*name)$/,
    ]
    const wfEvent = [
      /^(wedding\s*date|event\s*date|estimated\s*wedding\s*date)$/,
      /^(guest\s*count|estimated\s*guest\s*count|number\s*of\s*guests)$/,
    ]
    const ts = countMatches(norms, wfTimestamp)
    const ident = countMatches(norms, wfIdentity)
    const evt = countMatches(norms, wfEvent)
    if (ts >= 1 && ident >= 1 && evt >= 1) {
      const total = ts + ident + evt
      const confidence = total >= 5 ? 92 : 75
      return {
        shape: 'web_form',
        columns: {
          submitted_at: col(/^(submitted\s*at|submission\s*date|timestamp|received)$/),
          reference: col(/^(submission\s*id|network\s*id|reference\s*number)$/),
          name: col(/^(name|your\s*name|partner\s*one\s*name)$/),
          email: col(/^(email|email\s*address|your\s*email|partner\s*one\s*email)$/),
          phone: col(/^(phone(\s*number)?|your\s*phone|partner\s*one\s*phone)$/),
          partner_name: col(/^(partner('s)?\s*name|partner\s*two\s*name)$/),
          partner_email: col(/^(partner('s)?\s*email|partner\s*two\s*email)$/),
          wedding_date: col(/^(wedding\s*date|event\s*date|estimated\s*wedding\s*date)$/),
          guest_count: col(/^(guest\s*count|estimated\s*guest\s*count|number\s*of\s*guests)$/),
          notes: col(/^(notes|anything\s*else.*|additional\s*information)$/),
        },
        headersNormalised: norms,
        confidence,
      }
    }
  }

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
