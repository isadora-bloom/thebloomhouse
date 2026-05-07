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

/**
 * Record a shadow decision (Tier-B #67A). Called from
 * checkAutoSendEligible whenever the matching rule has shadow_mode=true.
 * Captures the decision the rule WOULD have made so the coordinator can
 * review accuracy before promoting.
 *
 * Fire-and-forget. A failed insert (constraint violation, network blip)
 * must NOT block the calling email pipeline — coordinator review is the
 * eventual consistency check, not the eligibility decision.
 */
async function recordShadowDecision(args: {
  venueId: string
  ruleId: string | null
  draft: AutoSendCheck
  wouldHaveSent: boolean
  reason: string
}): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase.from('auto_send_shadow_decisions').insert({
      venue_id: args.venueId,
      rule_id: args.ruleId,
      wedding_id: args.draft.weddingId ?? null,
      thread_id: args.draft.threadId ?? null,
      context_type: args.draft.contextType,
      source: args.draft.source ?? null,
      confidence_score: args.draft.confidenceScore,
      injection_suspected: args.draft.injectionSuspected ?? false,
      would_have_sent: args.wouldHaveSent,
      reason: args.reason,
    })
  } catch (err) {
    console.warn(
      '[auto-sender] shadow_decision insert failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }
}

interface AutoSendCheck {
  contextType: string
  /**
   * Confidence score, integer 0–100. Matches brain output scale and
   * (post-migration 121) auto_send_rules.confidence_threshold scale.
   * Pre-migration the DB column was float 0.0–1.0 and we had a
   * dual-scale heuristic at the function boundary. Migration 121
   * made it strict — one scale everywhere. INV-7.3.
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
   * Direction of the engagement event that triggered this draft.
   * REQUIRED — no default. Per Playbook Invariant 15 the eligibility
   * check filters on direction before any other gate. Forcing every
   * caller to pass explicitly means a future call site that forgets
   * fails closed (TS error) instead of inheriting a permissive
   * 'inbound' default. Self-review of the original code change
   * (commit 439d012) flagged the default as a regression vector.
   */
  direction: 'inbound' | 'outbound'
  /**
   * Wedding ID — used for the require_new_contact gate. When the rule is
   * configured to only auto-send to never-before-seen contacts, we count
   * prior interactions on the same wedding and reject if any exist.
   */
  weddingId?: string
  /**
   * Set true when the inbound email triggered a high-confidence prompt-
   * injection signal (containsInjectionAttempt). When set, auto-send is
   * blocked unconditionally — a malicious inbound that survives the
   * sanitization wrapper still triggers an ineligible decision so a
   * coordinator reviews the draft before any reply leaves. Round-2
   * audit follow-up #36.
   */
  injectionSuspected?: boolean
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
  id: string
  enabled: boolean
  confidenceThreshold: number
  dailyLimit: number
  threadCap24h: number
  requireNewContact: boolean
  source: string
  /**
   * Tier-B #67A. When true, the eligibility chain runs to completion
   * but the decision is logged to auto_send_shadow_decisions instead
   * of firing. Coordinator promotes via /agent/auto-send-shadow.
   * Mig 227.
   */
  shadowMode: boolean
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

  // Forward-compat with prod-migration lag: shadow_mode lands in mig 227.
  // If the column isn't there yet, the SELECT returns Postgres error
  // 42703 (undefined_column). Without this guard, every venue's auto-send
  // silently falls through to "no rule" and stops firing. Round 8 #1.
  const colsWithShadow =
    'id, enabled, confidence_threshold, daily_limit, thread_cap_24h, require_new_contact, source, shadow_mode'
  const colsLegacy =
    'id, enabled, confidence_threshold, daily_limit, thread_cap_24h, require_new_contact, source'

  async function selectOne(
    matchSource: string
  ): Promise<{ row: Record<string, unknown> | null; hasShadowCol: boolean }> {
    const primary = await supabase
      .from('auto_send_rules')
      .select(colsWithShadow)
      .eq('venue_id', venueId)
      .eq('context', context)
      .eq('source', matchSource)
      .limit(1)

    if (primary.error && (primary.error as { code?: string }).code === '42703') {
      // Mig 227 not applied yet. Fall back to legacy column set; the
      // shadow-mode feature is dormant until the migration ships.
      const legacy = await supabase
        .from('auto_send_rules')
        .select(colsLegacy)
        .eq('venue_id', venueId)
        .eq('context', context)
        .eq('source', matchSource)
        .limit(1)
      const data = legacy.data as Array<Record<string, unknown>> | null
      const row = data && data.length > 0 ? data[0] : null
      return { row, hasShadowCol: false }
    }

    const data = primary.data as Array<Record<string, unknown>> | null
    const row = data && data.length > 0 ? data[0] : null
    return { row, hasShadowCol: true }
  }

  function toRule(row: Record<string, unknown>, hasShadowCol: boolean): AutoSendRule {
    return {
      id: row.id as string,
      enabled: row.enabled as boolean,
      confidenceThreshold: row.confidence_threshold as number,
      dailyLimit: row.daily_limit as number,
      threadCap24h: (row.thread_cap_24h as number) ?? 3,
      requireNewContact: (row.require_new_contact as boolean) ?? true,
      source: row.source as string,
      shadowMode: hasShadowCol ? ((row.shadow_mode as boolean) ?? false) : false,
    }
  }

  // Try source-specific rule first
  const sourceMatch = await selectOne(source)
  if (sourceMatch.row) return toRule(sourceMatch.row, sourceMatch.hasShadowCol)

  // Fall back to 'all' rule for this context
  const allMatch = await selectOne('all')
  if (allMatch.row) return toRule(allMatch.row, allMatch.hasShadowCol)

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
  // other gate. direction is REQUIRED on AutoSendCheck — TS catches
  // missing callers; this runtime check enforces the enum.
  if (draft.direction !== 'inbound') {
    return {
      eligible: false,
      reason: `Auto-send blocked: direction is '${draft.direction}', not 'inbound' (INV-15)`,
    }
  }

  // Check 0c: Prompt-injection containment. When the inbound email
  // matched containsInjectionAttempt the eligibility decision is
  // unconditional ineligible — a competitor or hostile inquirer
  // could have injected directives into the email body intended to
  // hijack the auto-reply. The draft is still saved for coordinator
  // review (the wrapping in inquiry-brain neutralised the directives
  // for the model output) but it does NOT auto-send. Round-2 audit
  // follow-up #36.
  if (draft.injectionSuspected) {
    return {
      eligible: false,
      reason: 'Auto-send blocked: inbound email contained a prompt-injection signal',
    }
  }

  // Post-migration 121 confidence is one scale (integer 0-100) end-
  // to-end. The Repair K dual-scale heuristic was removed when the
  // strict path landed. Single scale = no leaky abstraction; future
  // callers pass brain output raw.

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

  // From here on we have an enabled rule. Tier-B #67A: when the rule is
  // in shadow_mode, the gates below run normally but we capture the
  // would-be-decision instead of short-circuiting return. At the end we
  // log the decision to auto_send_shadow_decisions and force an
  // ineligible result so the email pipeline doesn't actually fire.
  //
  // Pattern: a helper that returns the rule-specific gate decision as
  // a plain object. Live mode returns it directly; shadow mode logs it,
  // then returns shadow-blocked.
  const decision = await runRuleGates(venueId, rule, draft, ruleSource)

  if (rule.shadowMode) {
    await recordShadowDecision({
      venueId,
      ruleId: rule.id,
      draft,
      wouldHaveSent: decision.eligible,
      reason: decision.reason,
    })
    return {
      eligible: false,
      reason: `Shadow mode: rule would have ${decision.eligible ? 'sent' : 'blocked'}. ${decision.reason}`,
    }
  }

  return decision
}

/**
 * Run the rule-specific gates (checks 2-5) and return the would-be
 * decision. Extracted from checkAutoSendEligible so the same code path
 * serves both live and shadow modes — guarantees parity between what
 * shadow logs say and what live sends do.
 */
async function runRuleGates(
  venueId: string,
  rule: AutoSendRule,
  draft: AutoSendCheck,
  ruleSource: string,
): Promise<AutoSendResult> {
  // Check 2: Confidence threshold. Both sides integer 0-100 (post-121).
  if (draft.confidenceScore < rule.confidenceThreshold) {
    return {
      eligible: false,
      reason: `Confidence ${draft.confidenceScore} below threshold ${rule.confidenceThreshold}`,
    }
  }

  // Check 3: require_new_contact.
  if (rule.requireNewContact && draft.weddingId) {
    const supabase = createServiceClient()
    const { count, error: priorErr } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', draft.weddingId)
    if (priorErr) {
      console.error('[auto-sender] require_new_contact lookup failed:', priorErr.message)
      return {
        eligible: false,
        reason: 'require_new_contact gate failed: unable to count prior interactions',
      }
    }
    if ((count ?? 0) > 1) {
      return {
        eligible: false,
        reason: `require_new_contact: wedding has ${count} prior interactions; rule allows new contacts only`,
      }
    }
  }

  // Check 4: Per-thread rolling-24h cap.
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

  return {
    eligible: true,
    reason:
      `Auto-send approved: source '${ruleSource}', confidence ${draft.confidenceScore}, ` +
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
