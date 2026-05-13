// ---------------------------------------------------------------------------
// inbox/lifecycle.ts — decide which folder a thread belongs to.
// ---------------------------------------------------------------------------
//
// Companion to migration 242. Six folders, single closed enum:
//
//   new_inquiry      — first inbound from this lead, no outbound yet.
//   potential_client — couple replied / tour booked / wedding past inquiry.
//   client           — wedding booked.
//   vendor           — sender role is vendor.
//   advertiser       — cold outreach from ad / SaaS / sales platforms.
//   other            — everything else.
//
// The function is intentionally pure: callers gather the required context
// (thread counts, wedding status, sender domain, sender role) once and
// pass it in. That keeps the email pipeline's hot path fast — no extra
// Supabase round-trips inside the decider — and lets unit tests cover
// every priority branch without mocking the database.
//
// The priority order matches the SQL backfill in migration 242. Keep the
// two in lock-step: an advertiser domain caught in TS but not the SQL
// (or vice-versa) leaves the inbox folder counts visibly drifting from
// what the live pipeline writes.
// ---------------------------------------------------------------------------

import type { createServiceClient } from '@/lib/supabase/service'
import { loadVendorDomains } from './vendor-domains'

export type LifecycleFolder =
  | 'new_inquiry'
  | 'potential_client'
  | 'client'
  | 'vendor'
  | 'advertiser'
  | 'other'

export const LIFECYCLE_FOLDERS: readonly LifecycleFolder[] = [
  'new_inquiry',
  'potential_client',
  'client',
  'vendor',
  'advertiser',
  'other',
] as const

// Coordinator-facing labels. Keeps the SQL enum strings (snake_case)
// decoupled from the inbox tab labels — if Isadora wants to rename
// "Potential Clients" to "Active" later, only this map changes.
// No em-dashes by memory rule.
export const LIFECYCLE_LABELS: Record<LifecycleFolder, string> = {
  new_inquiry: 'New Inquiries',
  potential_client: 'Potential Clients',
  client: 'Clients',
  vendor: 'Vendors',
  advertiser: 'Advertisers',
  other: 'Other',
}

// ---------------------------------------------------------------------------
// Advertiser domain allow-list.
// ---------------------------------------------------------------------------
//
// Cold outreach from listing platforms (Knot / WeddingWire / Zola), SaaS
// CRM and sales tools (HubSpot / Salesforce / Mailchimp), B2B prospecting
// (Apollo / ZoomInfo / Lusha), and recruiter spam (LinkedIn / Indeed).
//
// Editable: this is the source of truth for the live pipeline. The SQL
// backfill in migration 242 carries a copy of the same list; if you add
// a domain here, mirror it there too (or run the file as a one-shot
// reclass with `coordinator-reclass-folder` once that surface ships).
//
// Important rule applied at decision time: a domain match alone does NOT
// land the row in 'advertiser'. The thread must have NO wedding link
// (weddingStatus === null) — otherwise we would demote a real lead that
// happened to come in via a Knot relay.
export const ADVERTISER_DOMAINS: readonly string[] = [
  // Wedding listing platforms (when soliciting, not relaying).
  'theknot.com',
  'mail.theknot.com',
  'auth.theknot.com',
  'member.theknot.com',
  'weddingwire.com',
  'mail.weddingwire.com',
  'authsolic.com',
  'zola.com',
  'mail.zola.com',
  'herecomestheguide.com',
  'wedj.com',
  'weddingspot.com',
  'wedsites.com',
  'joinleads.com',

  // SaaS CRM / marketing automation outreach.
  'hubspot.com',
  'salesforce.com',
  'mailchimp.com',
  'intercom.io',
  'drift.com',
  'klaviyo.com',
  'pipedrive.com',
  'monday.com',
  'asana.com',
  'clickup.com',
  'notion.so',

  // Sales prospecting / cold-email tooling.
  'outreach.io',
  'apollo.io',
  'zoominfo.com',
  'lusha.com',
  'seamless.ai',
  'reply.io',
  'instantly.ai',
  'lemlist.com',
  'mailshake.com',

  // Recruiting / job platforms (frequent venue-coordinator spam).
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',

  // AI tooling / dev sales.
  'openai.com',
  'anthropic.com',
  'replicate.com',
  'huggingface.co',

  // Generic agency / SEO / marketing outreach.
  'semrush.com',
  'ahrefs.com',
  'moz.com',
  'wix.com',
  'squarespace.com',
  'godaddy.com',
  'namecheap.com',

  // Common venue-coordinator spam categories.
  'eventective.com',
  'eventup.com',
  'partyslate.com',
  'venuereport.com',
] as const

const ADVERTISER_DOMAIN_SET: ReadonlySet<string> = new Set(
  ADVERTISER_DOMAINS.map((d) => d.toLowerCase()),
)

/**
 * True if `domain` (or its parent suffix) matches the advertiser
 * allow-list. Matches `mail.theknot.com` against `theknot.com`, etc.
 * Defensive lower-casing — callers may pass domain straight from a
 * `from_email` header which preserves the user's casing.
 */
export function isAdvertiserDomain(domain: string | null | undefined): boolean {
  if (!domain) return false
  const d = domain.toLowerCase().trim()
  if (!d) return false
  if (ADVERTISER_DOMAIN_SET.has(d)) return true
  // Suffix match — `notifications.mailchimp.com` matches `mailchimp.com`.
  for (const dom of ADVERTISER_DOMAIN_SET) {
    if (d.endsWith(`.${dom}`)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Pure decision function.
// ---------------------------------------------------------------------------

export type WeddingStatusInput =
  | 'inquiry'
  | 'tour_scheduled'
  | 'tour_completed'
  | 'proposal_sent'
  | 'booked'
  | 'completed'
  | 'lost'
  | 'cancelled'
  | null

/** Sender-side intent classes the LLM may emit. Imported as a string
 *  to keep this module independent of the intent classifier's full
 *  enum union (avoids a coupling that would force lifecycle.ts to
 *  re-export every intent change). Unknown values are treated as
 *  null. */
export type IntentClassInput = string | null

export interface LifecycleDecisionInput {
  /**
   * Intent verdict from the unified inbound classifier (the LLM's
   * judgment on what kind of message this is). Drives sender-side
   * folder selection — replaces the prior "rule chain + AI fallback"
   * shape. Pass null when the row has not yet been classified
   * (rule chain falls back to structural-only signals).
   */
  intentClass: IntentClassInput
  /** weddings.status. null when the interaction has no wedding link. */
  weddingStatus: WeddingStatusInput
  /** weddings.booked_at — non-null is also enough to flip to 'client'. */
  bookedAt?: string | null
  /** Number of inbound interactions on this gmail_thread_id (lead-side). */
  inboundCount: number
  /** Number of outbound interactions on this gmail_thread_id (venue-side). */
  outboundCount: number
  /** True if any tour engagement event exists on the linked wedding. */
  hasTourEvent: boolean
  /** Sender domain extracted from from_email. lower-cased preferred. */
  senderDomain: string | null
  /** people.role on the joined person (partner1 / vendor / family /
   *  etc). Trusts the classifier verdict over this when they disagree
   *  — a stale 'vendor' role on a real couple shouldn't pin them in
   *  Vendors forever. */
  senderRole: string | null
  /**
   * Per-venue vendor-domain allow-list (migration 258). When the
   * sender domain is on this list AND no wedding is linked, returns
   * 'vendor' directly. Belongs to the venue's CRM truth, not the
   * classifier's judgment — coordinator-curated.
   */
  venueVendorDomains?: Set<string> | null
}

/**
 * Decide which lifecycle folder a thread belongs to.
 *
 * 2026-05-12 doctrine rewrite. Previously the function ran a 7-step
 * rule chain with an optional Haiku fallback at step 6. That meant
 * sender-side judgment (vendor / advertiser / new_inquiry) was driven
 * by stale people.role values and a hard-coded ADVERTISER_DOMAINS
 * allow-list, with Haiku second-guessing only when the rules ran out.
 *
 * The unified inbound classifier (intent_class) is now the SINGLE
 * source of LLM judgment per inbound. Folder selection becomes a
 * deterministic function of:
 *   - CRM state (wedding booked / tour scheduled / past inquiry) =>
 *     STRUCTURAL FLOOR. A booked wedding is 'client' regardless of
 *     intent. A tour scheduled is 'potential_client'.
 *   - intent_class => sender-side judgment. new_inquiry /
 *     inquiry_followup → new_inquiry. client_* → potential_client.
 *     vendor_* → vendor. spam_outreach → advertiser (when domain
 *     matches) or other. auto_reply / coordinator_internal /
 *     unknown → other.
 *   - Per-venue vendor-domain allow-list => coordinator-curated
 *     promotion of unknown-but-trusted vendor domains.
 *
 * No second Haiku call. No "rule chain decides, AI patches" hybrid.
 * If intent_class is null (pre-classifier row, drain hasn't run),
 * fall back to the structural signals + advertiser-domain check.
 */
export function decideLifecycleFolder(
  input: LifecycleDecisionInput,
): LifecycleFolder {
  const {
    intentClass,
    weddingStatus,
    bookedAt,
    inboundCount,
    outboundCount,
    hasTourEvent,
    senderDomain,
    senderRole,
    venueVendorDomains,
  } = input

  // ----- STRUCTURAL FLOOR — CRM state always wins -----
  //
  // A booked wedding is a client, even if the latest inbound looks
  // like vendor outreach. A scheduled tour is a potential_client.
  // These are hard CRM truths the classifier can't override.

  if (
    weddingStatus === 'booked' ||
    weddingStatus === 'completed' ||
    !!bookedAt
  ) {
    return 'client'
  }

  if (
    weddingStatus === 'tour_scheduled' ||
    weddingStatus === 'tour_completed' ||
    weddingStatus === 'proposal_sent' ||
    hasTourEvent
  ) {
    return 'potential_client'
  }

  if (weddingStatus === 'inquiry' && outboundCount >= 1 && inboundCount >= 2) {
    // Couple has replied back at least once after our outreach —
    // they're engaged, no longer a brand-new inquiry.
    return 'potential_client'
  }

  // ----- INTENT-DRIVEN — classifier verdict drives the rest -----
  //
  // intent_class is the LLM's judgment on what the message IS. We
  // map the 11 intent classes to the 6 folders below. CRM state is
  // already accounted for above, so the mapping is sender-shape only.

  if (intentClass) {
    switch (intentClass) {
      case 'new_inquiry':
      case 'inquiry_followup':
        return 'new_inquiry'

      case 'client_logistics':
      case 'client_emotional':
      case 'family_member_proxy':
        // Classifier says "this is a booked-couple-side message" but
        // we have no booked wedding linked. Either the link hasn't
        // resolved yet (race) or the classifier missed. Treat as
        // engaged-lead (potential_client) — never demote to vendor
        // or advertiser when the classifier says client-side.
        return 'potential_client'

      case 'vendor_communication':
      case 'vendor_outreach':
        return 'vendor'

      case 'spam_outreach':
        // Cold solicitation. If the sender domain is on the
        // advertiser allow-list, it's an advertiser (Knot pitching
        // venues, SaaS sales, etc); otherwise just other.
        if (isAdvertiserDomain(senderDomain)) return 'advertiser'
        return 'other'

      case 'auto_reply':
      case 'coordinator_internal':
      case 'unknown':
        return 'other'

      default:
        // Forward-compat: unknown intent string falls through to the
        // null-intent path below.
        break
    }
  }

  // ----- NULL-INTENT FALLBACK — classifier hasn't run yet -----
  //
  // Pre-classifier rows + interactions where the drain hasn't caught
  // up. Use structural signals only. Once intent_class lands, the
  // folder writer recomputes from this same function.

  if (
    !weddingStatus &&
    senderDomain &&
    isAdvertiserDomain(senderDomain)
  ) {
    return 'advertiser'
  }

  if (senderRole === 'vendor') return 'vendor'

  if (
    !weddingStatus &&
    senderDomain &&
    venueVendorDomains &&
    venueVendorDomains.size > 0
  ) {
    if (venueVendorDomains.has(senderDomain)) return 'vendor'
    for (const dom of venueVendorDomains) {
      if (senderDomain.endsWith(`.${dom}`)) return 'vendor'
    }
  }

  if (weddingStatus === 'inquiry' && inboundCount <= 1) {
    return 'new_inquiry'
  }

  return 'other'
}

// ---------------------------------------------------------------------------
// DB helper: compute + write the folder for a thread.
// ---------------------------------------------------------------------------
//
// Called from the email pipeline after every inbound or outbound write.
// Gathers the context the pure decider needs, then UPDATEs every
// interaction on the thread to the resolved folder. We update the whole
// thread (not just the one row) because the "potential_client" boundary
// flips on the second inbound — and the inbox tab counts must show the
// historical first inbound under the same folder so the thread doesn't
// split across two tabs.
//
// Best-effort: a failure here mustn't block the email pipeline. The
// nightly maintenance job (data-integrity cron) will reconcile any
// drift.

type ServiceClient = ReturnType<typeof createServiceClient>

export interface UpdateThreadFolderArgs {
  supabase: ServiceClient
  venueId: string
  /** gmail_thread_id. Threads without an id get a single-row update. */
  threadId: string | null
  /** interactions.id of the row that triggered this update. */
  interactionId?: string | null
  /**
   * @deprecated 2026-05-12. The Haiku folder-AI fallback was retired
   * when intent_class became the single source of LLM judgment per
   * inbound. updateThreadLifecycleFolder now reads intent_class from
   * the most recent inbound on the thread and feeds it into the
   * deterministic decideLifecycleFolder mapper. Field kept on the
   * args interface so existing callers compile; ignored at runtime.
   */
  useAi?: boolean
  /**
   * Optional correlation id, threaded into logging for traceability.
   */
  correlationId?: string
  /**
   * Direct intent_class override — bypasses the DB lookup for the
   * thread's most recent inbound. The live pipeline runs
   * classifyInboundRaw synchronously early but stamps the row
   * fire-and-forget AFTER the interaction insert. Passing the
   * verdict's intent_class here avoids the race where
   * updateThreadLifecycleFolder reads the row before stamping has
   * landed. Falls back to the DB lookup when null/undefined.
   */
  intentClassOverride?: string | null
}

export async function updateThreadLifecycleFolder(
  args: UpdateThreadFolderArgs,
): Promise<{ folder: LifecycleFolder | null; updated: number }> {
  const { supabase, venueId, threadId, interactionId, intentClassOverride } = args
  // useAi + correlationId no longer load-bearing — the AI fallback
  // was retired in favour of reading intent_class from the row.

  // Step 1: Fetch every interaction on the thread for this venue.
  // venue_id is enforced so a forensic-replay run on a different
  // venue can't mutate rows it shouldn't.
  // We always pull subject + body + from_name + timestamp so the AI
  // fallback path has the inputs it needs without a second round trip.
  // The extra columns are small (subject/body_preview are short, full_body
  // is a TEXT but rarely huge for emails) and the rule-only callers
  // simply ignore them.
  let q = supabase
    .from('interactions')
    .select('id, direction, wedding_id, person_id, from_email, from_name, subject, full_body, body_preview, timestamp, gmail_thread_id, intent_class')
    .eq('venue_id', venueId)
    .eq('type', 'email')

  if (threadId) {
    q = q.eq('gmail_thread_id', threadId)
  } else if (interactionId) {
    q = q.eq('id', interactionId)
  } else {
    return { folder: null, updated: 0 }
  }

  const { data: rows, error: rowErr } = await q
  if (rowErr || !rows || rows.length === 0) {
    return { folder: null, updated: 0 }
  }

  // Step 2: Aggregate inbound/outbound counts + collect the wedding +
  // sender context. We pick the most-recent inbound row's sender as the
  // representative sender for vendor/advertiser detection — outbound
  // rows are always venue-side so their from_email tells us nothing
  // about the thread's classification.
  let inboundCount = 0
  let outboundCount = 0
  let weddingId: string | null = null
  let personId: string | null = null
  let senderEmail: string | null = null

  for (const r of rows) {
    if (r.direction === 'inbound') {
      inboundCount += 1
      if (!senderEmail && r.from_email) {
        senderEmail = (r.from_email as string).toLowerCase()
      }
    } else if (r.direction === 'outbound') {
      outboundCount += 1
    }
    if (!weddingId && r.wedding_id) weddingId = r.wedding_id as string
    if (!personId && r.person_id) personId = r.person_id as string
  }

  // Step 3: Resolve wedding status + booked_at.
  let weddingStatus: WeddingStatusInput = null
  let bookedAt: string | null = null
  if (weddingId) {
    const { data: w } = await supabase
      .from('weddings')
      .select('status, booked_at')
      .eq('id', weddingId)
      .maybeSingle()
    if (w) {
      weddingStatus = (w.status as WeddingStatusInput) ?? null
      bookedAt = (w.booked_at as string | null) ?? null
    }
  }

  // Step 4: Resolve sender role from people. Prefer person_id when
  // present; fall back to email match within venue scope.
  let senderRole: string | null = null
  if (personId) {
    const { data: p } = await supabase
      .from('people')
      .select('role')
      .eq('id', personId)
      .maybeSingle()
    senderRole = (p?.role as string | null) ?? null
  } else if (senderEmail) {
    const { data: p } = await supabase
      .from('people')
      .select('role')
      .eq('venue_id', venueId)
      .eq('email', senderEmail)
      .limit(1)
      .maybeSingle()
    senderRole = (p?.role as string | null) ?? null
  }

  // Step 5: Tour-event existence — a single EXISTS-style probe is
  // enough; we don't need the row payload.
  let hasTourEvent = false
  if (weddingId) {
    const { data: ee } = await supabase
      .from('engagement_events')
      .select('id')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .in('event_type', ['tour_requested', 'tour_scheduled', 'tour_completed'])
      .limit(1)
    hasTourEvent = !!(ee && ee.length > 0)
  }

  // Step 6: Decide.
  const senderDomain = senderEmail && senderEmail.includes('@')
    ? senderEmail.split('@').pop()!.toLowerCase()
    : null

  // Load the per-venue vendor-domain allow-list once. Cached 5min
  // inside loadVendorDomains, so the cron polling 50 emails on the
  // same venue pays the DB hit once. Defensive empty-set on error.
  // Best-effort: if the load fails the rule chain still works; the
  // vendor pass simply degrades to "no allow-list match".
  let venueVendorDomains: Set<string> | null = null
  try {
    venueVendorDomains = await loadVendorDomains(venueId)
  } catch {
    venueVendorDomains = null
  }

  // Step 6: Load intent_class. The unified classifier stamps this on
  // every inbound; we read it so the folder decision uses the LLM's
  // verdict instead of running a separate folder-AI Haiku call.
  //
  // Prefer the caller's override when supplied (live pipeline path —
  // avoids a race where the fire-and-forget stamp hasn't landed yet).
  // Otherwise read from the row.
  let intentClass: string | null = intentClassOverride ?? null
  if (!intentClass) {
    type InboundLite = {
      direction: string
      intent_class?: string | null
      timestamp?: string | null
    }
    const inboundRows = (rows as unknown as InboundLite[]).filter(
      (r) => r.direction === 'inbound' && r.intent_class,
    )
    inboundRows.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0
      return tb - ta
    })
    intentClass = inboundRows[0]?.intent_class ?? null
  }

  // Step 7: Decide.
  const folder = decideLifecycleFolder({
    intentClass,
    weddingStatus,
    bookedAt,
    inboundCount,
    outboundCount,
    hasTourEvent,
    senderDomain,
    senderRole,
    venueVendorDomains,
  })

  // Step 7: Stamp every interaction on the thread. Using gmail_thread_id
  // when available means coordinator-side outbound rows from a sibling
  // Gmail connection get the same folder without an extra round trip.
  let updateQ = supabase
    .from('interactions')
    .update({ lifecycle_folder: folder })
    .eq('venue_id', venueId)
    .eq('type', 'email')

  if (threadId) {
    updateQ = updateQ.eq('gmail_thread_id', threadId)
  } else if (interactionId) {
    updateQ = updateQ.eq('id', interactionId)
  }

  const { error: updateErr } = await updateQ
  if (updateErr) {
    return { folder, updated: 0 }
  }

  return { folder, updated: rows.length }
}
