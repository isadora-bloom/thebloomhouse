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

  const signals = await callAIJson<Omit<ExtractedSignals, 'urgency'>>({
    systemPrompt: `You are a wedding venue inquiry analyzer. Extract structured data from the email text.

Return a JSON object with these fields:
- clientName: string | null — the person writing the email
- partnerName: string | null — their partner if mentioned
- eventDate: string | null — in YYYY-MM-DD format if possible, or the raw date string
- guestCount: number | null — estimated guest count
- eventType: string | null — "wedding", "reception", "rehearsal dinner", "elopement", "corporate", etc.
- budgetRange: { min: number, max: number } | null — dollar amounts if mentioned
- questions: string[] — specific questions they asked
- sentiment: "positive" | "neutral" | "cautious" | "negative"
- stressSignals: string[] — phrases indicating stress ("overwhelmed", "running out of time", etc.)
- excitementSignals: string[] — phrases indicating excitement ("can't wait", "dream venue", etc.)
- mentionedVendors: string[] — any vendor names or types mentioned (photographer, caterer, etc.)
- specialRequests: string[] — accessibility needs, dietary restrictions, cultural traditions, etc.

Be precise. Only extract what is explicitly stated or clearly implied. Do not guess.`,
    userPrompt: emailBody,
    maxTokens: 1500,
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

  return {
    ...signals,
    urgency,
  }
}
