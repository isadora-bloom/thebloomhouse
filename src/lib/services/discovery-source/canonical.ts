/**
 * Bloom House — Wave 15 discovery-source canonical mapper.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator-visible signal — every captured
 *     answer to "How did you hear about us?" lands somewhere visible)
 *   - bloom-may9-llm-vs-template.md (deterministic mapping; no LLM
 *     needed for keyword classification — Fix #2 in Wave 15 is
 *     deterministic per the directive)
 *
 * What this is
 * ------------
 * Single deterministic mapper from a verbatim "How did you hear about
 * us?" answer to a canonical source label. Used by:
 *   - Calendly webhook (extract Q&A → write discovery_sources +
 *     attribution_events row)
 *   - Any future intake form that captures the same question
 *
 * Per Wave 14 doctrine: ChatGPT-as-referrer is NOT a human referrer
 * (so the referral extractor rightly refuses it). Wave 15's job is to
 * capture the value as a SOURCE — ai_tool — so it doesn't fall in a
 * hole.
 */

export type CanonicalDiscoverySource =
  | 'ai_tool'
  | 'instagram'
  | 'tiktok'
  | 'pinterest'
  | 'google'
  | 'theknot'
  | 'weddingwire'
  | 'friend'
  | 'vendor'
  | 'social_media'
  | 'other'
  | 'unknown'

/**
 * Question-text matcher. Returns true if the question text looks like
 * a "Where did you hear about us?" question. Substring match,
 * case-insensitive — the wording varies per venue.
 */
const QUESTION_PATTERNS = [
  'hear about us',
  'hear of us',
  'find us',
  'find out about us',
  'discover us',
  'find about us',
  'how did you find',
  'how did you hear',
  'how did you discover',
  'how did you learn',
  'where did you hear',
  'where did you find',
  'where did you discover',
  "how'd you find",
  "how'd you hear",
  "how'd you discover",
  'referred you',
  'who recommended',
  'who referred',
] as const

export function isDiscoveryQuestion(questionText: string | null | undefined): boolean {
  if (!questionText) return false
  const q = questionText.toLowerCase()
  return QUESTION_PATTERNS.some((p) => q.includes(p))
}

/**
 * Map a verbatim answer to a canonical source.
 *
 * Rules (deterministic, longest-match first within each tier):
 *   1. AI tools — chatgpt / gpt-* / claude / perplexity / bard / gemini /
 *                  copilot / ai chatbot / ai assistant / ai search
 *   2. Named platforms — instagram / tiktok / pinterest / google /
 *                         the knot / weddingwire / yelp / facebook
 *   3. Word-of-mouth — friend / family / referral / word of mouth
 *   4. Vendor — vendor / photographer / planner / florist / venue /
 *                wedding planner
 *   5. Generic social — social / social media (if not matched above)
 *   6. unknown — null / empty / whitespace
 *   7. other — present but unrecognised
 */
export function mapToCanonicalDiscoverySource(
  answer: string | null | undefined,
): CanonicalDiscoverySource {
  if (!answer) return 'unknown'
  const a = answer.toLowerCase().trim()
  if (!a) return 'unknown'

  // Tier 1: AI tools
  const aiPatterns = [
    'chatgpt',
    'chat gpt',
    'chat-gpt',
    'gpt-3',
    'gpt-4',
    'gpt-5',
    'gpt 3',
    'gpt 4',
    'gpt 5',
    'openai',
    'open ai',
    'claude',
    'anthropic',
    'perplexity',
    'bard',
    'gemini',
    'copilot',
    'ai chatbot',
    'ai chat bot',
    'ai assistant',
    'ai search',
    'ai bot',
    'llm',
  ]
  for (const p of aiPatterns) {
    if (a.includes(p)) return 'ai_tool'
  }
  // Standalone "gpt" or "ai" — guard with word boundary, otherwise
  // "raining" would match "ai".
  if (/(^|[^a-z])gpt([^a-z]|$)/.test(a)) return 'ai_tool'
  if (/(^|[^a-z])ai([^a-z]|$)/.test(a)) {
    // But not "main" / "rain" / "wait". The negative-class regex above
    // covers that.
    return 'ai_tool'
  }

  // Tier 2: Named platforms — order matters (longest first)
  if (a.includes('instagram') || a.includes('insta') || a.startsWith('ig ') || a === 'ig') {
    return 'instagram'
  }
  if (a.includes('tiktok') || a.includes('tik tok') || a.includes('tik-tok')) {
    return 'tiktok'
  }
  if (a.includes('pinterest') || a.includes('pintrest')) {
    return 'pinterest'
  }
  if (
    a.includes('the knot') ||
    a.includes('theknot') ||
    a.includes('the-knot') ||
    /(^|[^a-z])knot([^a-z]|$)/.test(a)
  ) {
    return 'theknot'
  }
  if (
    a.includes('wedding wire') ||
    a.includes('weddingwire') ||
    a.includes('wedding-wire')
  ) {
    return 'weddingwire'
  }
  if (
    a.includes('google') ||
    a.includes('googled') ||
    a.includes('google maps') ||
    a.includes('google search') ||
    a.includes('searched online') ||
    a === 'search engine'
  ) {
    return 'google'
  }

  // Tier 3: Word-of-mouth
  if (
    a.includes('friend') ||
    a.includes('family') ||
    a.includes('referral') ||
    a.includes('referred') ||
    a.includes('recommendation') ||
    a.includes('recommended') ||
    a.includes('word of mouth') ||
    a.includes('word-of-mouth') ||
    a.includes('told me') ||
    a.includes('through my')
  ) {
    return 'friend'
  }

  // Tier 4: Vendor
  if (
    a.includes('vendor') ||
    a.includes('photographer') ||
    a.includes('planner') ||
    a.includes('wedding planner') ||
    a.includes('florist') ||
    a.includes('caterer') ||
    a.includes('coordinator')
  ) {
    return 'vendor'
  }

  // Tier 5: Generic social
  if (
    a.includes('social media') ||
    a.includes('social') ||
    a.includes('facebook') ||
    a.includes('fb ') ||
    a === 'fb' ||
    a.includes('reddit')
  ) {
    return 'social_media'
  }

  return 'other'
}

/**
 * Convenience: returns BOTH the canonical mapping AND a confidence
 * descriptor for audit. Confidence is rule-derived, not LLM-derived.
 */
export interface MapResult {
  canonical: CanonicalDiscoverySource
  rule_matched: string
}

export function mapWithRule(answer: string | null | undefined): MapResult {
  const canonical = mapToCanonicalDiscoverySource(answer)
  if (!answer) return { canonical, rule_matched: 'empty_answer' }
  const a = answer.toLowerCase().trim()
  if (!a) return { canonical, rule_matched: 'whitespace_answer' }
  switch (canonical) {
    case 'ai_tool':
      return { canonical, rule_matched: 'ai_tool_keyword' }
    case 'instagram':
    case 'tiktok':
    case 'pinterest':
    case 'theknot':
    case 'weddingwire':
    case 'google':
      return { canonical, rule_matched: 'platform_keyword' }
    case 'friend':
      return { canonical, rule_matched: 'word_of_mouth_keyword' }
    case 'vendor':
      return { canonical, rule_matched: 'vendor_keyword' }
    case 'social_media':
      return { canonical, rule_matched: 'social_keyword' }
    case 'other':
      return { canonical, rule_matched: 'no_rule_matched' }
    default:
      return { canonical, rule_matched: 'unknown' }
  }
}
