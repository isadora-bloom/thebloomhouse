/**
 * Bloom House: Signal Extraction Service
 *
 * Extracts structured data from email text using a combination of keyword
 * matching and AI. The extracted signals drive heat mapping, lead scoring,
 * and personalized draft generation.
 */

import { callAIJson } from '@/lib/ai/client'
import type { HandlePlatform } from './identity/sources/types'
import { normalizeHandle, normalizeHandles } from './identity/handles'

/**
 * Prompt revision identifier. Per Playbook OPS-21.5.1 / T1-E.
 * See PROMPTS-CHANGELOG.md for version history.
 *
 * v1.1 (2026-09-11, HANDLE-IDENTITY-SPEC.md §4, wave 3): added the
 * `handles` field — see PROMPTS-CHANGELOG.md for the full entry.
 *
 * v1.2 (2026-09-14, wave 7 W50): added the `intentions` field. A stated
 * plan is not a question and was falling through both — see
 * PROMPTS-CHANGELOG.md.
 */
export const EXTRACTION_PROMPT_VERSION = 'extraction.prompt.v1.2'

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
  /**
   * Stated plans. "We are having a groom's cake", "we want sparklers at
   * the send-off", "my uncle is officiating". Distinct from `questions`:
   * a question asks us for something, an intention tells us something the
   * couple has already decided and expects to happen on the day.
   *
   * Nobody was capturing these. They arrived in an email to the
   * coordinator, were read once, and never reached the day-of timeline.
   * `services/commitments/reconcile.ts` is what closes that loop.
   */
  intentions: string[]
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

  // Wave 3 (HANDLE-IDENTITY-SPEC.md §4): platform handles found in the
  // email — a signature line ("IG @rosie.hoyle") the model reads plus
  // a deterministic parse of any instagram.com/<handle>-style profile
  // URL in the body. Both are normalised through normalizeHandle();
  // malformed candidates are dropped silently (a dropped-count warning
  // goes to the console, nothing junk is ever stored). null when the
  // email carried no recognisable handle.
  handles: Partial<Record<HandlePlatform, string>> | null
}

// ---------------------------------------------------------------------------
// Contract signing detection — re-exported from booking-signal.ts (F8).
// Kept here as a re-export so existing imports keep compiling; new callers
// should import directly from '@/lib/services/booking-signal'.
// ---------------------------------------------------------------------------

export { detectBookingSignal, detectContractSigning } from './booking-signal'
export type { BookingSignalResult } from './booking-signal'

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

// Keys MUST match canonical values in normalize-source.ts so extracted
// sources flow through to weddings.source without a second translation.
const LEAD_SOURCES: Record<string, string[]> = {
  the_knot: ['the knot', 'theknot'],
  zola: ['zola'],
  wedding_wire: ['weddingwire', 'wedding wire'],
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
// Wave 3 (HANDLE-IDENTITY-SPEC.md §4) — handle extraction.
//
// Two sources, merged:
//   1. The model reads a plain-text handle out of a signature or body
//      line ("IG @rosie.hoyle", "Find us on Instagram @rosieandsam").
//      That is classification/extraction from prose, so it goes through
//      the existing LLM path (see the system prompt below), never a
//      regex over the body text.
//   2. A profile URL ("https://instagram.com/rosie.hoyle") is a URL,
//      not prose — finding one and reading its path segment is a
//      deterministic, syntactic operation the repo's "no regex on user
//      text" rule does not reach. URL_TOKEN_RE below only ever matches
//      the shape of a URL; it never interprets meaning from the text
//      around it.
//
// Both sources are normalised through normalizeHandle() before either
// is trusted. A candidate that fails normalisation is dropped —
// counted, logged, never stored.
// ---------------------------------------------------------------------------

const HANDLE_PLATFORMS: readonly HandlePlatform[] = [
  'instagram', 'tiktok', 'facebook', 'pinterest', 'twitter', 'knot', 'weddingwire', 'zola',
]
const KNOWN_HANDLE_PLATFORMS = new Set<string>(HANDLE_PLATFORMS)

const URL_TOKEN_RE = /https?:\/\/[^\s<>"')]+/gi

/**
 * Strip any key the model returned that isn't one of the closed
 * `HandlePlatform` values (a hallucinated platform, a typo). Guards
 * `normalizeHandle()` against an unknown key — its per-platform lookup
 * tables assume the closed set and are not defensive against a free
 * string. Exported for the unit test.
 */
export function sanitiseHandlePlatformKeys(
  raw: Partial<Record<string, string | null | undefined>> | null | undefined,
): Partial<Record<HandlePlatform, string>> | null {
  if (!raw) return null
  const out: Partial<Record<HandlePlatform, string>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !value.trim()) continue
    if (KNOWN_HANDLE_PLATFORMS.has(key)) {
      out[key as HandlePlatform] = value
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Deterministic profile-URL parse. Scans free text for http(s) URL
 * tokens and, for each one, tries every known platform's
 * `normalizeHandle()` until one recognises the host. Returns the
 * merged handle map, or null when no URL matched a known profile
 * host. Exported for the unit test.
 */
export function extractHandlesFromUrls(text: string): Partial<Record<HandlePlatform, string>> | null {
  if (!text) return null
  const urls = text.match(URL_TOKEN_RE) ?? []
  if (urls.length === 0) return null
  const out: Partial<Record<HandlePlatform, string>> = {}
  for (const url of urls) {
    for (const platform of HANDLE_PLATFORMS) {
      if (out[platform]) continue
      const handle = normalizeHandle(platform, url)
      if (handle) out[platform] = handle
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Merge the model's signature/body read with the deterministic
 * profile-URL parse and normalise everything. The URL parse is exact,
 * so it wins per-platform when both sources fire for the same
 * platform. Malformed candidates from either source are dropped —
 * `dropped` counts how many, for the caller to log; nothing malformed
 * is ever returned. Exported for the unit test.
 */
export function mergeAndNormaliseHandles(args: {
  modelHandles: Partial<Record<string, string | null | undefined>> | null | undefined
  emailBody: string
}): { handles: Partial<Record<HandlePlatform, string>> | null; dropped: number } {
  const sanitised = sanitiseHandlePlatformKeys(args.modelHandles)
  const rawCandidateCount = sanitised ? Object.keys(sanitised).length : 0
  const modelNormalised = normalizeHandles(sanitised)
  const dropped = rawCandidateCount - (modelNormalised ? Object.keys(modelNormalised).length : 0)
  const urlHandles = extractHandlesFromUrls(args.emailBody)
  const merged =
    modelNormalised || urlHandles ? { ...modelNormalised, ...urlHandles } : null
  return { handles: merged, dropped }
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
// Response coercion
// ---------------------------------------------------------------------------

/**
 * The model is asked for a fixed schema and usually returns it. Usually is
 * not always: a field can come back missing, null, or as a bare string
 * instead of an array. Every list field on ExtractedSignals is typed
 * `string[]` and callers index into it, so an `undefined` here becomes a
 * TypeError two modules away from the cause.
 *
 * Coerce instead. A missing list is an empty list, a bare string is a
 * one-item list, and non-string members are dropped. Entries are trimmed
 * and blanks removed so a quote-per-line answer does not turn into a row
 * of empty commitments on the coordinator's queue.
 */
export function coerceStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    const single = value.trim()
    return single.length > 0 ? [single] : []
  }
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
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
    intentions: string[]
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
    // Wave 3 (HANDLE-IDENTITY-SPEC.md §4). Raw model read of a
    // signature/body handle line — sanitised + normalised below
    // before it ever reaches ExtractedSignals.handles.
    handles: Partial<Record<string, string>> | null
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
- intentions: string[] — things they say they ARE doing or WANT on the day, stated as fact rather than asked as a question ("we're having a groom's cake", "my uncle is officiating", "we want sparklers at the send-off"). Quote or closely paraphrase each one. A sentence is an intention when nobody has to answer it but somebody has to plan for it. If it is phrased as a question it belongs in questions, not here.
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
- handles: object | null — social-media handles or usernames the sender explicitly gives, most often in a signature line ("IG @rosie.hoyle", "Find us on Instagram @rosieandsam", "TikTok: @the.hoyles"). Keys are one or more of "instagram", "tiktok", "facebook", "pinterest", "twitter" — use a key only when that platform is clearly named. Value is the handle exactly as written (keep the "@" if present, keep case, do not strip or reformat). Do NOT guess a handle from a name, and do NOT invent one from a URL — a bare profile link is parsed separately. null when no handle is given.

Be precise. Only extract what is explicitly stated or clearly implied. Do not guess.`,
    userPrompt: emailBody,
    maxTokens: 2000,
    temperature: 0.1,
    venueId,
    taskType: 'signal_extraction',
    // Haiku tier per Playbook 19.8 — bounded structured extraction
    // with a fixed schema. Sonnet was overkill for this workload.
    // OPS-21.4.2.
    tier: 'haiku',
    promptVersion: EXTRACTION_PROMPT_VERSION,
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

  // Wave 3 (HANDLE-IDENTITY-SPEC.md §4): merge the model's signature/
  // body handle read with the deterministic profile-URL parse. Junk
  // from either source is dropped, counted, and logged — never stored.
  const { handles, dropped: droppedHandles } = mergeAndNormaliseHandles({
    modelHandles: signals.handles,
    emailBody,
  })
  if (droppedHandles > 0) {
    console.warn(
      `[extraction] dropped ${droppedHandles} malformed handle candidate(s) from model output`,
    )
  }

  return {
    ...signals,
    // Every list field goes through the coercer, not just the new one. The
    // model omitting `intentions` is the same failure as it omitting
    // `questions`; both used to hand a caller `undefined` typed as string[].
    questions: coerceStringList(signals.questions),
    intentions: coerceStringList(signals.intentions),
    stressSignals: coerceStringList(signals.stressSignals),
    excitementSignals: coerceStringList(signals.excitementSignals),
    mentionedVendors: coerceStringList(signals.mentionedVendors),
    specialRequests: coerceStringList(signals.specialRequests),
    painPoints: coerceStringList(signals.painPoints),
    objectionSignals: coerceStringList(signals.objectionSignals),
    keyPriorities: coerceStringList(signals.keyPriorities),
    venuesTouring: coerceStringList(signals.venuesTouring),
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
    // Platform handles — model read + deterministic URL parse, merged.
    handles,
  }
}
