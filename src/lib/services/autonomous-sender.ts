/**
 * Bloom House: Autonomous Sender Service
 *
 * Auto-send rules engine that determines whether a draft can be sent
 * automatically without coordinator approval. Configurable separately
 * for inquiry and client contexts, with per-source rules.
 *
 * Pre-send checks (in order):
 *   1. Is auto-send enabled for this context + source?
 *   2. Does confidence score meet threshold?
 *   3. Has daily limit been reached?
 *   4. Source-specific rule matching?
 *
 * DISABLED BY DEFAULT — must be explicitly enabled per context per venue.
 *
 * Ported from bloom-agent-main/backend/services/autonomous_sender.py
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutoSendCheck {
  contextType: string
  confidenceScore: number
  source?: string
  /**
   * Gmail thread ID for per-thread rolling-24h cap enforcement. Optional so
   * tests and synthetic paths without a thread ID still type-check — the
   * thread cap gate skips when absent. In the live pipeline this is always
   * provided via email-pipeline.ts.
   */
  threadId?: string
}

interface AutoSendResult {
  eligible: boolean
  reason: string
}

interface AutoSendStats {
  totalSent: number
  byContext: Record<string, number>
  bySource: Record<string, number>
  approvalRateComparison: {
    autoSentCount: number
    manualApprovedCount: number
    manualRejectedCount: number
    manualApprovalRate: number
  }
}

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

const SOURCE_PATTERNS: Record<string, RegExp[]> = {
  theknot: [/@member\.theknot\.com$/i, /@theknot\.com$/i],
  zola: [/@zola\.com$/i],
  weddingwire: [/@weddingwire\.com$/i],
  calculator: [/contact@interactivecalculator\.com/i],
}

/**
 * Detect the source platform from an email address.
 * Returns the platform name or 'direct' for unknown senders.
 */
function detectSource(email: string): string {
  const lower = email.toLowerCase()

  for (const [source, patterns] of Object.entries(SOURCE_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(lower)) return source
    }
  }

  return 'direct'
}

// ---------------------------------------------------------------------------
// Internal: fetch rules for a venue + context
// ---------------------------------------------------------------------------

interface AutoSendRule {
  enabled: boolean
  confidenceThreshold: number
  dailyLimit: number
  threadCap24h: number
  source: string
}

/**
 * Get auto-send rules for a venue and context. Checks for source-specific
 * rules first, then falls back to an 'all' rule, then returns disabled
 * defaults.
 */
async function getMatchingRule(
  venueId: string,
  context: string,
  source: string
): Promise<AutoSendRule | null> {
  const supabase = createServiceClient()

  // Try source-specific rule first
  const { data: sourceRule } = await supabase
    .from('auto_send_rules')
    .select('enabled, confidence_threshold, daily_limit, thread_cap_24h, source')
    .eq('venue_id', venueId)
    .eq('context', context)
    .eq('source', source)
    .limit(1)

  if (sourceRule && sourceRule.length > 0) {
    return {
      enabled: sourceRule[0].enabled as boolean,
      confidenceThreshold: sourceRule[0].confidence_threshold as number,
      dailyLimit: sourceRule[0].daily_limit as number,
      threadCap24h: (sourceRule[0].thread_cap_24h as number) ?? 3,
      source: sourceRule[0].source as string,
    }
  }

  // Fall back to 'all' rule for this context
  const { data: allRule } = await supabase
    .from('auto_send_rules')
    .select('enabled, confidence_threshold, daily_limit, thread_cap_24h, source')
    .eq('venue_id', venueId)
    .eq('context', context)
    .eq('source', 'all')
    .limit(1)

  if (allRule && allRule.length > 0) {
    return {
      enabled: allRule[0].enabled as boolean,
      confidenceThreshold: allRule[0].confidence_threshold as number,
      dailyLimit: allRule[0].daily_limit as number,
      threadCap24h: (allRule[0].thread_cap_24h as number) ?? 3,
      source: allRule[0].source as string,
    }
  }

  // No rule found — auto-send is not configured
  return null
}

// ---------------------------------------------------------------------------
// Exported: checkAutoSendEligible
// ---------------------------------------------------------------------------

/**
 * Check whether a draft is eligible for automatic sending.
 *
 * Checks in order:
 *   1. Does a matching auto-send rule exist and is it enabled?
 *   2. Does the confidence score meet the rule's threshold?
 *   3. Has the daily limit been reached for this context?
 *   4. Source-specific matching
 *
 * Returns { eligible: boolean, reason: string } explaining the decision.
 */
export async function checkAutoSendEligible(
  venueId: string,
  draft: AutoSendCheck
): Promise<AutoSendResult> {
  const source = draft.source ?? 'direct'
  const detectedSource = typeof draft.source === 'string'
    ? detectSource(draft.source)
    : 'direct'

  // Use the detected source for rule matching if draft.source looks like an email
  const ruleSource = draft.source?.includes('@') ? detectedSource : source

  // Check 1: Get matching rule
  const rule = await getMatchingRule(venueId, draft.contextType, ruleSource)

  if (!rule) {
    return {
      eligible: false,
      reason: `No auto-send rule configured for context '${draft.contextType}' and source '${ruleSource}'`,
    }
  }

  if (!rule.enabled) {
    return {
      eligible: false,
      reason: `Auto-send disabled for context '${draft.contextType}', source '${rule.source}'`,
    }
  }

  // Check 2: Confidence threshold
  if (draft.confidenceScore < rule.confidenceThreshold) {
    return {
      eligible: false,
      reason: `Confidence ${draft.confidenceScore.toFixed(2)} below threshold ${rule.confidenceThreshold.toFixed(2)}`,
    }
  }

  // Check 3: Per-thread rolling-24h cap. Belt-and-braces against
  // auto-responder loops — venue-wide `daily_limit` can hide a runaway
  // single thread. Skipped when threadId is absent (tests / synthetic
  // paths). Ordered BEFORE the daily cap so the deny reason is specific
  // when both would deny.
  if (draft.threadId) {
    const threadCount = await getRecentThreadAutoSendCount(venueId, draft.threadId)
    if (threadCount >= rule.threadCap24h) {
      return {
        eligible: false,
        reason: `Thread cap reached: ${threadCount}/${rule.threadCap24h} auto-sends on thread in last 24h`,
      }
    }
  }

  // Check 4: Daily limit (venue-wide, per-context, calendar-day)
  const todayCount = await getTodayAutoSendCount(venueId, draft.contextType)
  if (todayCount >= rule.dailyLimit) {
    return {
      eligible: false,
      reason: `Daily limit reached: ${todayCount}/${rule.dailyLimit} for context '${draft.contextType}'`,
    }
  }

  // All checks passed
  return {
    eligible: true,
    reason: `Auto-send approved: source '${ruleSource}', confidence ${draft.confidenceScore.toFixed(2)}, ` +
      `count ${todayCount + 1}/${rule.dailyLimit}`,
  }
}

// ---------------------------------------------------------------------------
// Exported: getAutoSendStats
// ---------------------------------------------------------------------------

/**
 * Get auto-send statistics for a venue. Includes total sent, breakdown by
 * context and source, and an approval rate comparison to manual reviews.
 */
export async function getAutoSendStats(
  venueId: string,
  period: 'today' | 'week' | 'month' = 'month'
): Promise<AutoSendStats> {
  const supabase = createServiceClient()

  // Calculate the start date for the period
  const now = new Date()
  let since: string

  if (period === 'today') {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  } else if (period === 'week') {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  } else {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  }

  // Fetch auto-sent drafts
  const { data: autoSent } = await supabase
    .from('drafts')
    .select('context_type, auto_send_source')
    .eq('venue_id', venueId)
    .eq('auto_sent', true)
    .gte('created_at', since)

  // Fetch manually handled drafts (for approval rate comparison)
  const { data: manualDrafts } = await supabase
    .from('drafts')
    .select('status')
    .eq('venue_id', venueId)
    .eq('auto_sent', false)
    .in('status', ['approved', 'rejected', 'sent'])
    .gte('created_at', since)

  // Aggregate auto-sent by context
  const byContext: Record<string, number> = {}
  const bySource: Record<string, number> = {}

  for (const draft of autoSent ?? []) {
    const ctx = (draft.context_type as string) ?? 'unknown'
    const src = (draft.auto_send_source as string) ?? 'unknown'

    byContext[ctx] = (byContext[ctx] ?? 0) + 1
    bySource[src] = (bySource[src] ?? 0) + 1
  }

  // Calculate manual approval rate
  const manualApproved = (manualDrafts ?? []).filter(
    (d) => d.status === 'approved' || d.status === 'sent'
  ).length
  const manualRejected = (manualDrafts ?? []).filter(
    (d) => d.status === 'rejected'
  ).length
  const manualTotal = manualApproved + manualRejected

  return {
    totalSent: autoSent?.length ?? 0,
    byContext,
    bySource,
    approvalRateComparison: {
      autoSentCount: autoSent?.length ?? 0,
      manualApprovedCount: manualApproved,
      manualRejectedCount: manualRejected,
      manualApprovalRate: manualTotal > 0
        ? Math.round((manualApproved / manualTotal) * 1000) / 10
        : 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Exported: getTodayAutoSendCount
// ---------------------------------------------------------------------------

/**
 * Count auto-sent drafts on a Gmail thread within the last rolling 24h.
 * Used by the eligibility check to enforce `auto_send_rules.thread_cap_24h`.
 *
 * Must query `sent_at` (actual send), not `created_at` — a draft generated
 * but never sent must not count against the cap. Must filter `auto_sent=true`
 * — coordinator manual sends never count, so a coordinator can always
 * intervene on a hot thread without burning the cap.
 */
export async function getRecentThreadAutoSendCount(
  venueId: string,
  threadId: string
): Promise<number> {
  const supabase = createServiceClient()

  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Two-step join via interaction_id (Supabase-JS doesn't support arbitrary
  // joins in a single query). First find interactions on this thread, then
  // count qualifying auto-sent drafts.
  const { data: threadInteractions, error: intErr } = await supabase
    .from('interactions')
    .select('id')
    .eq('venue_id', venueId)
    .eq('gmail_thread_id', threadId)

  if (intErr) {
    console.error('[auto-sender] Failed to fetch thread interactions:', intErr.message)
    return 0
  }
  const interactionIds = (threadInteractions ?? []).map((r) => r.id as string)
  if (interactionIds.length === 0) return 0

  const { data, error } = await supabase
    .from('drafts')
    .select('id')
    .eq('venue_id', venueId)
    .eq('auto_sent', true)
    .in('interaction_id', interactionIds)
    .gte('sent_at', windowStart)

  if (error) {
    console.error('[auto-sender] Failed to count thread auto-sends:', error.message)
    return 0
  }

  return data?.length ?? 0
}

/**
 * Count auto-sent drafts today for a given context (inquiry or client).
 * Used by the eligibility check to enforce daily limits.
 */
export async function getTodayAutoSendCount(
  venueId: string,
  context: string
): Promise<number> {
  const supabase = createServiceClient()

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const { data, error } = await supabase
    .from('drafts')
    .select('id')
    .eq('venue_id', venueId)
    .eq('auto_sent', true)
    .eq('context_type', context)
    .gte('created_at', todayStart.toISOString())

  if (error) {
    console.error('[auto-sender] Failed to count today auto-sends:', error.message)
    return 0
  }

  return data?.length ?? 0
}
