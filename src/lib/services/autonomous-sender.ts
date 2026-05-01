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
import { normalizeSource } from '@/lib/services/normalize-source'
import { isAutonomousPaused } from '@/lib/services/cost-ceiling'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutoSendCheck {
  contextType: string
  /**
   * Confidence score on 0.0–1.0 scale. The brains internally compute on a
   * 0–100 integer scale; callers must normalise to 0.0–1.0 before passing
   * here so the comparison against `auto_send_rules.confidence_threshold`
   * (also 0.0–1.0) is correct. Pre-fix, this was passed as 75–95 against a
   * 0.85 threshold and the gate silently never fired (75 ≥ 0.85 always
   * true). See Playbook INV-7.3.
   */
  confidenceScore: number
  source?: string
  /**
   * Gmail thread ID for per-thread rolling-24h cap enforcement. Optional so
   * tests and synthetic paths without a thread ID still type-check — the
   * thread cap gate skips when absent. In the live pipeline this is always
   * provided via email-pipeline.ts.
   */
  threadId?: string
  /**
   * Direction of the engagement event that triggered this draft. Per
   * Playbook Invariant 15, the eligibility check must filter on direction
   * before any other gate — autonomous-sender NEVER produces drafts in
   * response to outbound events. Defense-in-depth against upstream
   * misclassification (e.g., self-loop guard miss). Default 'inbound' for
   * legacy callers; new callers should pass explicitly.
   */
  direction?: 'inbound' | 'outbound'
  /**
   * Wedding ID — used for the require_new_contact gate. When the rule is
   * configured to only auto-send to never-before-seen contacts, we count
   * prior interactions on the same wedding and reject if any exist.
   */
  weddingId?: string
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

// Emit canonical source keys from normalize-source.ts so auto_send_rules
// matching aligns with wedding.source, brain-dump imports, and the
// onboarding seed. Pre-normalization these regexes emitted 'theknot' and
// 'calculator' which never matched the rules seeded for 'the_knot' /
// 'venue_calculator'.
const SOURCE_PATTERNS: Record<string, RegExp[]> = {
  the_knot: [/@member\.theknot\.com$/i, /@theknot\.com$/i],
  zola: [/@zola\.com$/i],
  wedding_wire: [/@weddingwire\.com$/i],
  venue_calculator: [/contact@interactivecalculator\.com/i],
}

/**
 * Detect the source platform from an email address.
 * Returns a canonical source key or 'direct' for unknown senders.
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
  requireNewContact: boolean
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
    .select('enabled, confidence_threshold, daily_limit, thread_cap_24h, require_new_contact, source')
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
      requireNewContact: (sourceRule[0].require_new_contact as boolean) ?? true,
      source: sourceRule[0].source as string,
    }
  }

  // Fall back to 'all' rule for this context
  const { data: allRule } = await supabase
    .from('auto_send_rules')
    .select('enabled, confidence_threshold, daily_limit, thread_cap_24h, require_new_contact, source')
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
      requireNewContact: (allRule[0].require_new_contact as boolean) ?? true,
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
 *   0. Direction is 'inbound' (Playbook INV-15: never auto-send in
 *      response to outbound events; defense-in-depth against upstream
 *      misclassification).
 *   1. Does a matching auto-send rule exist and is it enabled?
 *   2. Does the confidence score meet the rule's threshold? (0.0–1.0
 *      scale on both sides — see AutoSendCheck.confidenceScore docstring.)
 *   3. require_new_contact: if set, fail when the wedding has any prior
 *      interactions.
 *   4. Per-thread rolling-24h cap.
 *   5. Daily limit (venue-wide, per-context).
 *
 * Returns { eligible: boolean, reason: string } explaining the decision.
 */
export async function checkAutoSendEligible(
  venueId: string,
  draft: AutoSendCheck
): Promise<AutoSendResult> {
  // Check 0a: Cost-ceiling circuit breaker (Playbook OPS-21.4.3).
  // When the cost-ceiling cron has flipped autonomous_paused=true on
  // venue_config, no auto-sends. Drafts already in the queue stay for
  // manual approval. Coordinator resumes via /api/agent/cost-ceiling/resume
  // or the next-UTC-midnight reset.
  if (await isAutonomousPaused(venueId)) {
    return {
      eligible: false,
      reason: 'Auto-send blocked: venue autonomous behavior is paused (cost ceiling reached or coordinator override)',
    }
  }

  // Check 0b: Direction filter (Playbook INV-15). MUST run before any
  // other gate. Default 'inbound' for legacy callers, but new code must
  // pass explicitly so a future call site that forgets fails closed.
  const direction = draft.direction ?? 'inbound'
  if (direction !== 'inbound') {
    return {
      eligible: false,
      reason: `Auto-send blocked: direction is '${direction}', not 'inbound' (INV-15)`,
    }
  }

  const rawSource = draft.source ?? 'direct'
  const detectedSource = typeof draft.source === 'string'
    ? detectSource(draft.source)
    : 'direct'

  // If draft.source is an email address, use regex detection; otherwise
  // normalize whatever string the caller passed so rule matching never
  // fails on alias drift (theknot vs the_knot, wedding_wire vs weddingwire).
  const ruleSource = draft.source?.includes('@')
    ? detectedSource
    : normalizeSource(rawSource)

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

  // Check 2: Confidence threshold. Both sides on 0.0–1.0 scale.
  if (draft.confidenceScore < rule.confidenceThreshold) {
    return {
      eligible: false,
      reason: `Confidence ${draft.confidenceScore.toFixed(2)} below threshold ${rule.confidenceThreshold.toFixed(2)}`,
    }
  }

  // Check 3: require_new_contact. When set, only auto-send to contacts
  // not seen before. If the wedding has ANY prior interaction, fail —
  // coordinator wanted to handle returning contacts manually.
  if (rule.requireNewContact && draft.weddingId) {
    const supabase = createServiceClient()
    const { count, error: priorErr } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', draft.weddingId)
    if (priorErr) {
      console.error('[auto-sender] require_new_contact lookup failed:', priorErr.message)
      // Fail closed: if we can't verify, do not auto-send.
      return {
        eligible: false,
        reason: 'require_new_contact gate failed: unable to count prior interactions',
      }
    }
    // The current interaction itself may already be in the count when this
    // runs after interaction insert. Threshold of >1 (more than just this
    // one) means a prior touch existed.
    if ((count ?? 0) > 1) {
      return {
        eligible: false,
        reason: `require_new_contact: wedding has ${count} prior interactions; rule allows new contacts only`,
      }
    }
  }

  // Check 4: Per-thread rolling-24h cap. Belt-and-braces against
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

  // Check 5: Daily limit (venue-wide, per-context, calendar-day)
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
