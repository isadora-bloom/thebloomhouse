/**
 * Bloom House: Signal Extraction Service
 *
 * Extracts structured data from email text using a combination of keyword
 * matching and AI. The extracted signals drive heat mapping, lead scoring,
 * and personalized draft generation.
 */

import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedSignals {
  // Core contact info
  clientName: string | null
  partnerName: string | null
  eventDate: string | null
  guestCount: number | null
  eventType: string | null
  budgetRange: { min: number; max: number } | null
  questions: string[]
  urgency: 'high' | 'medium' | 'low'
  sentiment: 'positive' | 'neutral' | 'cautious' | 'negative'
  stressSignals: string[]
  excitementSignals: string[]
  mentionedVendors: string[]
  specialRequests: string[]

  // Phil's agent fields
  painPoints: string[]
  objectionSignals: string[]
  communicationStyle: 'formal' | 'casual' | 'detailed' | 'brief' | null
  keyPriorities: string[]
  followUpNeeded: boolean
  guestCountMin: number | null
  guestCountMax: number | null
  budgetMin: number | null
  budgetMax: number | null
  budgetVerbatim: string | null
  leadSource: string | null
  leadSourceDetail: string | null
  searchStage: 'just_started' | 'actively_touring' | 'final_decision' | null
  venuesTouring: string[]
  decisionTimeline: 'immediate' | 'this_month' | 'this_quarter' | 'flexible' | null
  contactRelationship: 'engaged' | 'parent' | 'planner' | 'friend' | null
  phoneNumbers: string[]
}

// ---------------------------------------------------------------------------
// Contract signing detection — quick regex scan for pipeline automation
// ---------------------------------------------------------------------------

const SIGNING_PATTERNS: RegExp[] = [
  // Contract language
  /signed the contract/i,
  /contract is signed/i,
  /sent the signed/i,
  /signed and returned/i,
  /we'?ve signed/i,
  /just signed/i,
  /attached.*signed/i,
  /signed.*attached/i,
  // Deposit / retainer language
  /deposit (?:has been |was |is )?(?:paid|received|sent|processed|wired)/i,
  /retainer (?:has been |was |is )?(?:paid|received|sent|processed)/i,
  /paid the (?:deposit|retainer)/i,
  // Commitment language — kept tight to avoid spurious matches on
  // enthusiastic inquiry-stage emails ("we're so excited about your venue").
  /we(?:'re| are) (?:officially )?booked/i,
  /booking (?:is )?confirmed/i,
  /we(?:'re| are) official(?:ly)?(?:\b|,|\.|$)/i,
]

/**
 * Scan email body for indicators that the couple has committed to booking.
 *
 * Returns the matched phrase (for audit + future learning) plus the boolean.
 * Fires for contract signing OR deposit/retainer references OR explicit
 * commitment language. Calendly tour confirmations never reach this path —
 * they are short-circuited before the classifier via venue_email_filters
 * action='ignore' (migration 069 + trigger in migration 072).
 */
export function detectBookingSignal(emailBody: string): { matched: boolean; phrase: string | null } {
  if (!emailBody) return { matched: false, phrase: null }
  for (const pattern of SIGNING_PATTERNS) {
    const match = emailBody.match(pattern)
    if (match) return { matched: true, phrase: match[0] }
  }
  return { matched: false, phrase: null }
}

/**
 * Back-compat: keep the old boolean signature so existing callers still
 * compile. New code should prefer detectBookingSignal for the matched
 * phrase.
 */
export function detectContractSigning(emailBody: string): boolean {
  return detectBookingSignal(emailBody).matched
}

// ---------------------------------------------------------------------------
// Urgency keyword sets
// ---------------------------------------------------------------------------

const HIGH_URGENCY_KEYWORDS = [
  'asap',
  'as soon as possible',
  'last minute',
  'last-minute',
  'next month',
  'this weekend',
  'this week',
  'urgent',
  'immediately',
  'right away',
  'tomorrow',
  'time sensitive',
  'short notice',
]

const MEDIUM_URGENCY_INDICATORS = [
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/,
  /\b(20\d{2})\b/,
  /\bnext\s+(spring|summer|fall|winter|year)\b/i,
]

// ---------------------------------------------------------------------------
// Phone / budget / lead source patterns (regex extraction)
// ---------------------------------------------------------------------------

const PHONE_PATTERNS = [
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  /\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/g,
]

const BUDGET_PATTERNS = [
  /\$[\d,]+(?:\s*[-–to]+\s*\$?[\d,]+)?/gi,
  /budget\s*(?:is|of|around|about)?\s*\$?[\d,]+/gi,
]

const LEAD_SOURCES: Record<string, string[]> = {
  the_knot: ['the knot', 'theknot'],
  zola: ['zola'],
  weddingwire: ['weddingwire', 'wedding wire'],
  google: ['google', 'google search'],
  instagram: ['instagram', 'insta'],
  facebook: ['facebook'],
  referral: ['friend', 'referred', 'recommendation'],
}

// ---------------------------------------------------------------------------
// Regex-based extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract phone numbers from text using regex patterns.
 */
function extractPhoneNumbers(text: string): string[] {
  const phones = new Set<string>()
  for (const pattern of PHONE_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      phones.add(match[0].trim())
    }
  }
  return Array.from(phones)
}

/**
 * Extract budget information from text using regex patterns.
 * Returns the raw verbatim string and parsed min/max if possible.
 */
function extractBudget(text: string): {
  verbatim: string | null
  min: number | null
  max: number | null
} {
  for (const pattern of BUDGET_PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) {
      const verbatim = match[0].trim()
      // Try to parse dollar amounts
      const amounts = verbatim.match(/\$?([\d,]+)/g)
      if (amounts && amounts.length >= 2) {
        const values = amounts.map((a) => parseInt(a.replace(/[$,]/g, ''), 10)).filter((n) => !isNaN(n))
        if (values.length >= 2) {
          return { verbatim, min: Math.min(...values), max: Math.max(...values) }
        }
      }
      if (amounts && amounts.length === 1) {
        const value = parseInt(amounts[0].replace(/[$,]/g, ''), 10)
        if (!isNaN(value)) {
          return { verbatim, min: value, max: null }
        }
      }
      return { verbatim, min: null, max: null }
    }
  }
  return { verbatim: null, min: null, max: null }
}

/**
 * Detect lead source from text by matching against known platform keywords.
 */
function detectLeadSource(text: string): { source: string | null; detail: string | null } {
  const lower = text.toLowerCase()
  for (const [key, keywords] of Object.entries(LEAD_SOURCES)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        // For referral, try to extract the referrer name
        if (key === 'referral') {
          const referrerMatch = lower.match(
            /(?:referred by|recommended by|friend)\s+([a-z]+(?:\s+[a-z]+)?)/i
          )
          return { source: key, detail: referrerMatch ? referrerMatch[1] : null }
        }
        return { source: key, detail: null }
      }
    }
  }
  return { source: null, detail: null }
}

// ---------------------------------------------------------------------------
// Date normalization
// ---------------------------------------------------------------------------

const MONTH_MAP: Record<string, string> = {
  january: '01', jan: '01',
  february: '02', feb: '02',
  march: '03', mar: '03',
  april: '04', apr: '04',
  may: '05',
  june: '06', jun: '06',
  july: '07', jul: '07',
  august: '08', aug: '08',
  september: '09', sep: '09', sept: '09',
  october: '10', oct: '10',
  november: '11', nov: '11',
  december: '12', dec: '12',
}

/**
 * Normalizes date strings ("May 15th", "5/15/2027", "next October") to
 * ISO date format (YYYY-MM-DD). Uses regex patterns first; falls back to
 * AI for ambiguous strings.
 */
export function normalizeDate(dateStr: string): string | null {
  const cleaned = dateStr.trim().toLowerCase()

  // Pattern: MM/DD/YYYY or M/D/YYYY
  const slashMatch = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (slashMatch) {
    const [, m, d, y] = slashMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // Pattern: YYYY-MM-DD (already ISO)
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    return cleaned
  }

  // Pattern: "Month Day, Year" or "Month Dayth/st/nd/rd Year"
  const longMatch = cleaned.match(
    /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})$/
  )
  if (longMatch) {
    const [, month, day, year] = longMatch
    const mm = MONTH_MAP[month]
    if (mm) {
      return `${year}-${mm}-${day.padStart(2, '0')}`
    }
  }

  // Pattern: "Month Dayth/st/nd/rd" (no year — assume next occurrence)
  const noYearMatch = cleaned.match(
    /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?$/
  )
  if (noYearMatch) {
    const [, month, day] = noYearMatch
    const mm = MONTH_MAP[month]
    if (mm) {
      const now = new Date()
      let year = now.getFullYear()
      const candidate = new Date(`${year}-${mm}-${day.padStart(2, '0')}`)
      if (candidate < now) year++
      return `${year}-${mm}-${day.padStart(2, '0')}`
    }
  }

  // Pattern: "next October" — return first of that month in the next occurrence
  const nextMonthMatch = cleaned.match(
    /^next\s+(january|february|march|april|may|june|july|august|september|october|november|december)$/
  )
  if (nextMonthMatch) {
    const [, month] = nextMonthMatch
    const mm = MONTH_MAP[month]
    if (mm) {
      const now = new Date()
      let year = now.getFullYear()
      const monthNum = parseInt(mm, 10) - 1
      if (monthNum <= now.getMonth()) year++
      return `${year}-${mm}-01`
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Urgency detection
// ---------------------------------------------------------------------------

/**
 * Keyword-based urgency detection.
 * - 'asap', 'last minute', 'next month', 'this weekend' = high
 * - Date mentioned = medium
 * - Otherwise = low
 */
export function detectUrgency(body: string): 'high' | 'medium' | 'low' {
  const lower = body.toLowerCase()

  // Check high-urgency keywords
  for (const keyword of HIGH_URGENCY_KEYWORDS) {
    if (lower.includes(keyword)) return 'high'
  }

  // Check medium-urgency indicators (date patterns)
  for (const pattern of MEDIUM_URGENCY_INDICATORS) {
    if (pattern.test(lower)) return 'medium'
  }

  return 'low'
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/**
 * Uses AI to extract structured signals from an email body.
 * Returns a typed ExtractedSignals object with client details, event
 * information, questions, sentiment, and more.
 */
export async function extractSignals(
  venueId: string,
  emailBody: string
): Promise<ExtractedSignals> {
  const urgency = detectUrgency(emailBody)

  // Run regex-based extractions in parallel with AI
  const phoneNumbers = extractPhoneNumbers(emailBody)
  const budgetInfo = extractBudget(emailBody)
  const leadSourceInfo = detectLeadSource(emailBody)

  // AI extraction type — fields that AI fills (excludes urgency and regex-extracted fields)
  interface AIExtractedSignals {
    clientName: string | null
    partnerName: string | null
    eventDate: string | null
    guestCount: number | null
    eventType: string | null
    budgetRange: { min: number; max: number } | null
    questions: string[]
    sentiment: 'positive' | 'neutral' | 'cautious' | 'negative'
    stressSignals: string[]
    excitementSignals: string[]
    mentionedVendors: string[]
    specialRequests: string[]
    painPoints: string[]
    objectionSignals: string[]
    communicationStyle: 'formal' | 'casual' | 'detailed' | 'brief' | null
    keyPriorities: string[]
    followUpNeeded: boolean
    guestCountMin: number | null
    guestCountMax: number | null
    searchStage: 'just_started' | 'actively_touring' | 'final_decision' | null
    venuesTouring: string[]
    decisionTimeline: 'immediate' | 'this_month' | 'this_quarter' | 'flexible' | null
    contactRelationship: 'engaged' | 'parent' | 'planner' | 'friend' | null
  }

  const signals = await callAIJson<AIExtractedSignals>({
    systemPrompt: `You are a wedding venue inquiry analyzer. Extract structured data from the email text.

Return a JSON object with these fields:
- clientName: string | null — the person writing the email
- partnerName: string | null — their partner if mentioned
- eventDate: string | null — in YYYY-MM-DD format if possible, or the raw date string
- guestCount: number | null — estimated guest count (single best estimate)
- eventType: string | null — "wedding", "reception", "rehearsal dinner", "elopement", "corporate", etc.
- budgetRange: { min: number, max: number } | null — dollar amounts if mentioned
- questions: string[] — specific questions they asked
- sentiment: "positive" | "neutral" | "cautious" | "negative"
- stressSignals: string[] — phrases indicating stress ("overwhelmed", "running out of time", etc.)
- excitementSignals: string[] — phrases indicating excitement ("can't wait", "dream venue", etc.)
- mentionedVendors: string[] — any vendor names or types mentioned (photographer, caterer, etc.)
- specialRequests: string[] — accessibility needs, dietary restrictions, cultural traditions, etc.
- painPoints: string[] — what is frustrating them (e.g. "venues not responding", "sticker shock", "overwhelming process")
- objectionSignals: string[] — signs of hesitation (e.g. "not sure about the drive", "might be out of our budget")
- communicationStyle: "formal" | "casual" | "detailed" | "brief" | null — how they write
- keyPriorities: string[] — what matters most to them (e.g. "outdoor ceremony", "great food", "affordable")
- followUpNeeded: boolean — should the coordinator proactively reach out?
- guestCountMin: number | null — low end of guest count range if given as a range
- guestCountMax: number | null — high end of guest count range if given as a range
- searchStage: "just_started" | "actively_touring" | "final_decision" | null — where they are in their venue search
- venuesTouring: string[] — competing venues they mention touring or considering
- decisionTimeline: "immediate" | "this_month" | "this_quarter" | "flexible" | null — how soon they plan to decide
- contactRelationship: "engaged" | "parent" | "planner" | "friend" | null — who is writing the email

Be precise. Only extract what is explicitly stated or clearly implied. Do not guess.`,
    userPrompt: emailBody,
    maxTokens: 2000,
    temperature: 0.1,
    venueId,
    taskType: 'signal_extraction',
  })

  // Normalize the extracted date if present
  if (signals.eventDate) {
    const normalized = normalizeDate(signals.eventDate)
    if (normalized) {
      signals.eventDate = normalized
    }
  }

  // Merge AI-extracted budget with regex-extracted budget (regex wins for verbatim)
  const budgetMin = budgetInfo.min ?? signals.budgetRange?.min ?? null
  const budgetMax = budgetInfo.max ?? signals.budgetRange?.max ?? null

  return {
    ...signals,
    urgency,
    // Merge regex-extracted phone numbers (dedup with any the AI might return)
    phoneNumbers,
    // Budget fields
    budgetMin,
    budgetMax,
    budgetVerbatim: budgetInfo.verbatim,
    // Lead source from regex detection
    leadSource: leadSourceInfo.source,
    leadSourceDetail: leadSourceInfo.detail,
  }
}
