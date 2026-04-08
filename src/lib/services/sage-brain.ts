/**
 * Bloom House: Sage Brain (Couple-Facing AI Concierge)
 *
 * Generates Sage's responses for the couple portal chat. Assembles the
 * full prompt stack:
 *   Layer 1: Universal rules
 *   Layer 2: Personality prompt (venue voice)
 *   Layer 3: Sage task prompt (couple-facing chat behavior)
 *   Layer 4: Intelligence context + KB search + wedding context
 *
 * Sage should feel like a knowledgeable, warm concierge who knows the
 * venue inside and out — not a generic chatbot.
 */

import { callAI } from '@/lib/ai/client'
import { buildPersonalityPrompt, type PersonalityData } from '@/lib/ai/personality-builder'
import { buildSageIntelligenceContext } from './sage-intelligence'
import { searchKnowledgeBase } from './knowledge-base'
import { createServiceClient } from '@/lib/supabase/service'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { getSageTaskPrompt } from '@/config/prompts/task-prompts-sage'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SageResponseOptions {
  venueId: string
  weddingId: string
  message: string
  conversationHistory: Array<{ role: string; content: string }>
  taskType?: string
}

export interface SageResponse {
  response: string
  confidence: number
  tokensUsed: number
  cost: number
  /** Whether the knowledge base had relevant matches */
  kbMatch: boolean
  /** The AI assistant name configured for this venue (e.g. "Sage") */
  aiName: string
  /** First name of partner_1, if available */
  coupleFirstName: string | null
}

interface WeddingContext {
  coupleName: string
  partnerName: string | null
  eventDate: string | null
  guestCount: number | null
  venueName: string
  status: string
  timelineItems: number
  budgetTotal: number | null
  budgetSpent: number | null
  checklistTotal: number
  checklistComplete: number
}

// ---------------------------------------------------------------------------
// Wedding context loader
// ---------------------------------------------------------------------------

/**
 * Loads wedding details, timeline items, budget summary, guest count,
 * and checklist progress for use as Sage context.
 */
export async function getWeddingContext(weddingId: string): Promise<WeddingContext | null> {
  const supabase = createServiceClient()

  // Load wedding + venue
  const { data: wedding, error: weddingError } = await supabase
    .from('weddings')
    .select(`
      id,
      status,
      wedding_date,
      guest_count,
      total_budget,
      venue_id,
      venues ( name )
    `)
    .eq('id', weddingId)
    .single()

  if (weddingError || !wedding) return null

  // Load primary contact (person 1)
  const { data: people } = await supabase
    .from('people')
    .select('first_name, last_name, role')
    .eq('wedding_id', weddingId)
    .in('role', ['partner_1', 'partner_2'])
    .order('role', { ascending: true })
    .limit(2)

  const partner1 = people?.[0]
  const partner2 = people?.[1]

  // Load timeline count
  const { count: timelineCount } = await supabase
    .from('timeline')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)

  // Load budget summary
  const { data: budgetItems } = await supabase
    .from('budget')
    .select('estimated_cost, actual_cost')
    .eq('wedding_id', weddingId)

  let budgetSpent = 0
  if (budgetItems) {
    for (const item of budgetItems) {
      budgetSpent += (item.actual_cost as number) ?? 0
    }
  }

  // Load checklist progress
  const { count: checklistTotal } = await supabase
    .from('timeline')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .eq('type', 'checklist')

  const { count: checklistComplete } = await supabase
    .from('timeline')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .eq('type', 'checklist')
    .eq('is_complete', true)

  const venueName =
    (wedding.venues as unknown as { name: string } | null)?.name ?? 'the venue'

  return {
    coupleName: partner1
      ? `${partner1.first_name} ${partner1.last_name}`
      : 'the couple',
    partnerName: partner2
      ? `${partner2.first_name} ${partner2.last_name}`
      : null,
    eventDate: wedding.wedding_date as string | null,
    guestCount: wedding.guest_count as number | null,
    venueName,
    status: wedding.status as string,
    timelineItems: timelineCount ?? 0,
    budgetTotal: wedding.total_budget as number | null,
    budgetSpent: budgetSpent > 0 ? budgetSpent : null,
    checklistTotal: checklistTotal ?? 0,
    checklistComplete: checklistComplete ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Confidence assessment
// ---------------------------------------------------------------------------

/**
 * Returns 0-100 confidence score.
 * - High (80-100): KB directly answers the question
 * - Medium (50-79): General venue knowledge applies
 * - Low (0-49): Hedging language detected or no KB match
 */
export function assessConfidence(response: string, kbMatch: boolean): number {
  const lower = response.toLowerCase()

  // Hedging language reduces confidence
  const hedgingPhrases = [
    "i'm not entirely sure",
    "i'm not sure",
    'i believe',
    'i think',
    'you may want to check',
    'you might want to ask',
    'i would recommend checking with',
    "i'd suggest reaching out",
    "i don't have that specific",
    'not certain',
    'double check',
    'double-check',
    'confirm with',
  ]

  let hedgingCount = 0
  for (const phrase of hedgingPhrases) {
    if (lower.includes(phrase)) hedgingCount++
  }

  if (kbMatch && hedgingCount === 0) return 95
  if (kbMatch && hedgingCount === 1) return 80
  if (kbMatch) return 65
  if (hedgingCount === 0) return 70
  if (hedgingCount === 1) return 50
  if (hedgingCount === 2) return 35
  return 20
}

// ---------------------------------------------------------------------------
// Personality loader
// ---------------------------------------------------------------------------

async function loadPersonalityData(venueId: string): Promise<PersonalityData> {
  const supabase = createServiceClient()

  const [aiConfigResult, venueResult, venueConfigResult, uspsResult, seasonalResult] =
    await Promise.all([
      supabase
        .from('venue_ai_config')
        .select('*')
        .eq('venue_id', venueId)
        .single(),
      supabase
        .from('venues')
        .select('name, website, phone')
        .eq('id', venueId)
        .single(),
      supabase
        .from('venue_config')
        .select('website_url, phone_number, tour_booking_url, pricing_calculator_url')
        .eq('venue_id', venueId)
        .single(),
      supabase
        .from('venue_usps')
        .select('usp_text')
        .eq('venue_id', venueId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('venue_seasonal_content')
        .select('season, imagery, phrases')
        .eq('venue_id', venueId),
    ])

  const config = (aiConfigResult.data as Record<string, unknown>) ?? {}
  const venue = venueResult.data ?? {}
  const venueConfig = venueConfigResult.data ?? {}
  const usps = (uspsResult.data ?? []).map((u) => u.usp_text as string)

  const seasonal: Record<string, { imagery?: string[]; phrases?: string[] }> = {}
  for (const row of seasonalResult.data ?? []) {
    seasonal[row.season as string] = {
      imagery: row.imagery as string[],
      phrases: row.phrases as string[],
    }
  }

  return {
    config: config as PersonalityData['config'],
    venue: venue as PersonalityData['venue'],
    venue_config: venueConfig as PersonalityData['venue_config'],
    usps,
    seasonal,
    signoff: (config.signoff as string) ?? '',
  }
}

// ---------------------------------------------------------------------------
// Main response generator
// ---------------------------------------------------------------------------

/**
 * Builds the full Sage prompt and generates a response:
 *   - Layer 1: Universal rules
 *   - Layer 2: Personality (venue voice)
 *   - Layer 3: Sage task prompt
 *   - Layer 4: Intelligence context + KB results + wedding context
 */
export async function generateSageResponse(
  options: SageResponseOptions
): Promise<SageResponse> {
  const { venueId, weddingId, message, conversationHistory, taskType } = options

  // Load all context in parallel
  const [personalityData, intelligenceContext, kbResults, weddingContext] =
    await Promise.all([
      loadPersonalityData(venueId),
      buildSageIntelligenceContext(venueId),
      searchKnowledgeBase(venueId, message),
      getWeddingContext(weddingId),
    ])

  // Build prompt layers
  const personalityPrompt = buildPersonalityPrompt(personalityData)
  const taskPrompt = getSageTaskPrompt(taskType ?? 'couple_question')

  // Format KB results for context
  let kbContext = ''
  const kbMatch = kbResults.length > 0
  if (kbMatch) {
    const topResults = kbResults.slice(0, 5)
    const kbLines = topResults.map(
      (entry) => `Q: ${entry.question}\nA: ${entry.answer}`
    )
    kbContext = `\n--- KNOWLEDGE BASE MATCHES ---\nUse these answers when relevant. Cite them naturally, don't say "according to our KB".\n\n${kbLines.join('\n\n')}\n--- END KB ---\n`
  }

  // Format wedding context
  let weddingBlock = ''
  if (weddingContext) {
    const parts: string[] = []
    parts.push(`Couple: ${weddingContext.coupleName}`)
    if (weddingContext.partnerName) {
      parts.push(`Partner: ${weddingContext.partnerName}`)
    }
    if (weddingContext.eventDate) {
      parts.push(`Wedding date: ${weddingContext.eventDate}`)
    }
    if (weddingContext.guestCount) {
      parts.push(`Guest count: ${weddingContext.guestCount}`)
    }
    parts.push(`Status: ${weddingContext.status}`)
    parts.push(`Venue: ${weddingContext.venueName}`)

    if (weddingContext.timelineItems > 0) {
      parts.push(`Timeline items: ${weddingContext.timelineItems}`)
    }
    if (weddingContext.budgetTotal) {
      const spent = weddingContext.budgetSpent
        ? ` ($${weddingContext.budgetSpent.toLocaleString()} spent)`
        : ''
      parts.push(`Budget: $${weddingContext.budgetTotal.toLocaleString()}${spent}`)
    }
    if (weddingContext.checklistTotal > 0) {
      parts.push(
        `Checklist: ${weddingContext.checklistComplete}/${weddingContext.checklistTotal} complete`
      )
    }

    weddingBlock = `\n--- WEDDING CONTEXT ---\n${parts.join('\n')}\n--- END WEDDING CONTEXT ---\n`
  }

  // Assemble full system prompt
  const systemPrompt = [
    UNIVERSAL_RULES,
    personalityPrompt,
    taskPrompt,
    weddingBlock,
    kbContext,
    intelligenceContext,
  ]
    .filter(Boolean)
    .join('\n\n')

  // Build messages array with conversation history
  const messages = conversationHistory
    .map((msg) => `${msg.role === 'user' ? 'Couple' : 'Sage'}: ${msg.content}`)
    .join('\n\n')

  const userPrompt = messages
    ? `${messages}\n\nCouple: ${message}`
    : `Couple: ${message}`

  // Generate response
  const result = await callAI({
    systemPrompt,
    userPrompt,
    maxTokens: 1500,
    temperature: 0.4,
    venueId,
    taskType: taskType ?? 'sage_chat',
  })

  const confidence = assessConfidence(result.text, kbMatch)

  // Extract aiName from personality config
  const aiName = (personalityData.config as Record<string, unknown>)?.ai_name as string | undefined

  return {
    response: result.text,
    confidence,
    tokensUsed: result.inputTokens + result.outputTokens,
    cost: result.cost,
    kbMatch,
    aiName: aiName || 'Sage',
    coupleFirstName: weddingContext?.coupleName?.split(' ')[0] ?? null,
  }
}
