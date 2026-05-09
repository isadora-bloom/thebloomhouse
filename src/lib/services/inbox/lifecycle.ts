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

export interface LifecycleDecisionInput {
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
  /** people.role on the joined person (partner1 / vendor / family / etc). */
  senderRole: string | null
  /**
   * Optional override from a downstream classifier. If the classifier
   * has already labelled the sender as 'vendor' or 'advertiser', we
   * trust it ahead of the heuristic chain. Today this hook is unused
   * but present so a future LLM-backed classifier can plug in.
   */
  senderClassification?: string | null
  /**
   * Optional folder hint from the AI classifier (folder-ai-classifier.ts).
   * Only consulted when the rule chain would otherwise return 'other'
   * AND there is no strong structured signal: no wedding link,
   * no people.role, no advertiser-domain match. The fallback ordering
   * keeps deterministic CRM signal authoritative; AI is a tie-breaker
   * for the long tail. Pass null/undefined to skip the AI branch.
   */
  aiClassification?: LifecycleFolder | null
  /**
   * Per-venue vendor-domain allow-list (migration 258). Sister of the
   * global ADVERTISER_DOMAINS but venue-scoped. When the rule chain
   * would otherwise fall to 'other', if the sender domain is on this
   * allow-list AND there's no wedding link, return 'vendor' directly —
   * skipping the Haiku reclass call. Loaded once per
   * updateThreadLifecycleFolder via loadVendorDomains() (5min cache).
   * Pass null/undefined or an empty set to disable the check.
   */
  venueVendorDomains?: Set<string> | null
}

/**
 * Decide which lifecycle folder a thread belongs to. Priority order
 * matches migration 242's SQL backfill exactly. Each branch is a
 * single boolean test against the input — no I/O, no allocations.
 */
export function decideLifecycleFolder(
  input: LifecycleDecisionInput,
): LifecycleFolder {
  const {
    weddingStatus,
    bookedAt,
    inboundCount,
    outboundCount,
    hasTourEvent,
    senderDomain,
    senderRole,
    senderClassification,
    aiClassification,
    venueVendorDomains,
  } = input

  // 1) Advertiser — sender domain in allow-list AND no wedding link.
  //    Without the no-wedding gate a Knot inquiry-relay would land here
  //    and the real lead would vanish from the inbox.
  if (
    !weddingStatus &&
    (senderClassification === 'advertiser' || isAdvertiserDomain(senderDomain))
  ) {
    return 'advertiser'
  }

  // 2) Vendor — explicit role on the joined person, or a downstream
  //    classifier handed us the label.
  if (senderRole === 'vendor' || senderClassification === 'vendor') {
    return 'vendor'
  }

  // 3) Client — wedding is booked.
  if (
    weddingStatus === 'booked' ||
    weddingStatus === 'completed' ||
    !!bookedAt
  ) {
    return 'client'
  }

  // 4) Potential client — wedding past 'inquiry', tour event exists,
  //    or the couple has replied back on this thread.
  if (
    weddingStatus === 'tour_scheduled' ||
    weddingStatus === 'tour_completed' ||
    weddingStatus === 'proposal_sent'
  ) {
    return 'potential_client'
  }
  if (hasTourEvent) return 'potential_client'
  if (outboundCount >= 1 && inboundCount >= 2) return 'potential_client'

  // 5) New inquiry — wedding is still in inquiry stage and the
  //    couple has not replied back yet. Inbound count <= 1 means
  //    the only inbound on the thread is the original inquiry /
  //    relay. Whether Sage has already sent a nurture reply is
  //    deliberately ignored: Isadora's rule is "never heard from
  //    before, never responded" meaning the COUPLE has not
  //    responded, not the venue. Without this relaxation, every
  //    Knot inquiry where Sage replied auto-fell into Other.
  if (
    weddingStatus === 'inquiry' &&
    inboundCount <= 1
  ) {
    return 'new_inquiry'
  }

  // 5b) Vendor — per-venue vendor-domain allow-list (mig 258). Sister
  //     of the global ADVERTISER_DOMAINS pass at step 1, but for the
  //     other side of the long tail. A coordinator (or Haiku via the
  //     reclass-folders-ai sweep) has previously confirmed this domain
  //     belongs to a real wedding-vendor business. Subsequent emails
  //     from the same domain skip the Haiku call and land in 'vendor'
  //     directly. Saves ~$0.0003/email × thousands per year.
  //
  //     Same no-wedding-link gate as the advertiser pass: a real
  //     vendor coordinating a SPECIFIC booked wedding still belongs
  //     under the wedding's lifecycle (client/potential_client),
  //     which the rule chain has already established by step 4. We
  //     only catch the un-tied case here.
  if (
    !weddingStatus &&
    senderDomain &&
    venueVendorDomains &&
    venueVendorDomains.size > 0
  ) {
    if (venueVendorDomains.has(senderDomain)) {
      return 'vendor'
    }
    // Suffix match — `notifications.gibsonrental.com` matches
    // `gibsonrental.com`. Mirrors isAdvertiserDomain() behaviour.
    for (const dom of venueVendorDomains) {
      if (senderDomain.endsWith(`.${dom}`)) return 'vendor'
    }
  }

  // 6) AI fallback — the rule chain is about to return 'other'. If
  //    we have an aiClassification AND no strong structured signal
  //    (no wedding link, no people.role, not on the advertiser list),
  //    trust the AI label. The "no strong signal" gate prevents the
  //    AI from second-guessing a deterministic CRM hit. We also drop
  //    AI labels that are themselves 'other' (no value-add) and
  //    disallow the AI from picking 'client' here, since 'client'
  //    requires a real weddings.booked_at link the AI cannot see.
  if (aiClassification && aiClassification !== 'other' && aiClassification !== 'client') {
    const hasStrongSignal =
      weddingStatus !== null ||
      senderRole !== null ||
      senderClassification === 'vendor' ||
      senderClassification === 'advertiser' ||
      isAdvertiserDomain(senderDomain)
    if (!hasStrongSignal) {
      return aiClassification
    }
  }

  // 7) Other — anything left.
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
   * Optional: when true, after the rule chain runs, if the would-be
   * folder is 'other' AND the most recent inbound on the thread has a
   * non-trivial body (>= 30 chars), classifyFolderAI is invoked and
   * the result is fed back through decideLifecycleFolder via
   * aiClassification. Default false. The live email pipeline keeps the
   * default off; the one-shot reclass endpoint flips it on.
   */
  useAi?: boolean
  /**
   * Optional correlation id passed through to the AI classifier so the
   * Haiku call lands in api_costs with the same correlation_id as the
   * triggering inbound. Ignored when useAi is false.
   */
  correlationId?: string
}

export async function updateThreadLifecycleFolder(
  args: UpdateThreadFolderArgs,
): Promise<{ folder: LifecycleFolder | null; updated: number }> {
  const { supabase, venueId, threadId, interactionId, useAi, correlationId } = args

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
    .select('id, direction, wedding_id, person_id, from_email, from_name, subject, full_body, body_preview, timestamp, gmail_thread_id')
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

  const ruleFolder = decideLifecycleFolder({
    weddingStatus,
    bookedAt,
    inboundCount,
    outboundCount,
    hasTourEvent,
    senderDomain,
    senderRole,
    venueVendorDomains,
  })

  // Step 6b: AI fallback — only when caller opted in AND the rule chain
  // would otherwise drop the thread into 'other'. We pick the most-recent
  // inbound row (richest body, freshest sender) and hand it to the AI
  // classifier. The result feeds back through decideLifecycleFolder via
  // aiClassification — keeping the deterministic rule chain authoritative.
  let folder = ruleFolder
  if (useAi && ruleFolder === 'other') {
    type InboundRow = {
      direction: string
      from_email?: string | null
      from_name?: string | null
      subject?: string | null
      full_body?: string | null
      body_preview?: string | null
      timestamp?: string | null
    }
    const inboundRows = (rows as unknown as InboundRow[]).filter(
      (r) => r.direction === 'inbound',
    )
    inboundRows.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0
      return tb - ta
    })
    const latest = inboundRows[0]
    const body = (latest?.full_body ?? latest?.body_preview ?? '').toString()
    if (latest && latest.from_email && body.length >= 30) {
      // Lazy import to keep the lifecycle module's import graph stable
      // for the unit tests that don't need the AI client surface.
      const { classifyFolderAI } = await import('./folder-ai-classifier')
      const ai = await classifyFolderAI(
        venueId,
        {
          from: latest.from_email,
          fromName: latest.from_name ?? null,
          subject: latest.subject ?? null,
          body,
          direction: 'inbound',
        },
        { correlationId },
      )
      folder = decideLifecycleFolder({
        weddingStatus,
        bookedAt,
        inboundCount,
        outboundCount,
        hasTourEvent,
        senderDomain,
        senderRole,
        aiClassification: ai.folder,
        venueVendorDomains,
      })
    }
  }

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
