/**
 * scripts/reattach-couple-author-orphans.ts
 * =========================================
 *
 * Orphan-touchpoint diagnosis fix #3 of 3 (2026-05-26).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * On prod (jsxxgwprxuqgcauzlxcb) there are 25 spine `touchpoints` rows
 * with `channel='gmail'`, `couple_id IS NULL`, whose source interaction
 * (joined via `raw_payload->>interaction_id`) carries
 * `interactions.author_class='couple'`. The author classifier was
 * confident enough to say "a couple wrote this" but the binder step
 * left the touchpoint unanchored. This is the highest-value orphan
 * subset because, by definition, every row IS supposed to land on
 * some couple — the only question is which one.
 *
 * Diagnosis priors (verified 2026-05-26 on prod):
 *   - All 25 are at Rixey (venue f3d10226-…).
 *   - Source interactions all have a person_id set, but none of those
 *     people currently have a `wedding_id`. So the simpler "person
 *     has a wedding now, attach via that" path that
 *     `reattach-orphan-interactions.ts` walks does NOT apply here.
 *   - Many sender addresses are HoneyBook relay tokens
 *     (`pm-inbound.honeybook.com`); the COUPLE'S REAL NAME lives in
 *     `interactions.from_name`, which is exactly the input the
 *     cascade matcher's stage-2 (exact full first + last) needs.
 *   - Naive full-name lookup against `couples` matches 15 of 25
 *     before we even invoke the real cascade. The real cascade will
 *     do better via stages 2b / 5b / nickname / body-cross-reference.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * For each couple-author orphan:
 *
 *   1. Reconstruct the `CascadeSignal` from `interactions` columns +
 *      `touchpoints.raw_payload`. The signal carries:
 *        - primary email + name + phone from interaction headers
 *        - body text (for stages 6/7/8 cross-reference)
 *        - body emails / phones if pre-extracted on the interaction
 *   2. Run `cascadeMatch(signal, candidates)` — the deterministic-
 *      first 10-stage cascade in `lib/services/identity/identity-
 *      cascade.ts`. Stage 1-5 + 5b are Tier 1 (deterministic email /
 *      phone / full-name / cross-name); stages 6-8 are also
 *      deterministic but are weaker so we still treat as Tier 1 if
 *      they fire here (they require explicit corroboration anyway).
 *   3. If the cascade returns a match → AUTO-BIND (Tier 1):
 *        - UPDATE touchpoints SET couple_id=<matched> WHERE id=<tp_id>.
 *        - INSERT couple_merge_events row with event_type='reattach'
 *          (added by migration 374) — primary_couple_id=<matched>,
 *          reason=`reattach: <stage> — <evidence>`.
 *      The UPDATE is NOT an INSERT/UPSERT so it does not trip the
 *      cascade-only-writer guard (which only blocks .insert / .upsert
 *      on the guarded tables). Verified via
 *      `node scripts/check-cascade-only-writer.mjs` after this script
 *      lands.
 *   4. If the cascade misses but `matcher.scoreCandidate` returns a
 *      best couple at medium/low tier → ENQUEUE a candidate_match
 *      row (Tier 2):
 *        - INSERT candidate_matches (primary=<best couple>,
 *          secondary=<touchpoint>, confidence_tier=<medium|low>).
 *      No touchpoint binding — the operator confirms via
 *      `/admin/identity/...` queue and the existing resolve endpoint
 *      handles the actual bind.
 *   5. If nothing matched at all → Tier 0, log and leave alone.
 *
 * SAFETY
 * ------
 *   - Default = DRY-RUN. Prints disposition breakdown + sample rows.
 *   - `--apply` writes (touchpoint UPDATE + audit row + candidate
 *     enqueue).
 *   - Refuse-by-default for prod (jsxxgwprxuqgcauzlxcb) per the
 *     pattern in `scripts/backfill-couples-bridge.ts` §Config.
 *     `--allow-prod` opts in; the script will refuse to write against
 *     prod without that flag even when `--apply` is set.
 *   - Idempotent: re-running after success is a no-op. The touchpoint
 *     UPDATE skips rows that already have a couple_id; the audit
 *     INSERT does too (the script re-fetches the orphan set per
 *     invocation, so a rebound row is excluded from the next pass).
 *   - Per-row try/catch — a single failed update does not poison the
 *     batch.
 *
 * WRITER-DOCTRINE CHECK
 * ---------------------
 * The cascade-only-writer guard (`check-cascade-only-writer.mjs`)
 * blocks `.insert(...)` / `.upsert(...)` on guarded tables outside
 * the chokepoint surface. It does NOT block `.update(...)`. Per the
 * guard's own docstring (line 5): "UPDATEs are NOT blocked
 * (lifecycle / heat / metadata routes keep their own functions)."
 * Touchpoint binding here is a metadata UPDATE: the row was created
 * by the live cascade with couple_id=NULL; this script populates that
 * column without creating a new row. The script intentionally does
 * NOT route through `linkSignal` for the bind because:
 *   (a) `linkSignal` writes a NEW touchpoint via insertTouchpoint,
 *       not an UPDATE of the existing row. The existing touchpoint's
 *       UNIQUE(venue_id, channel, external_id) makes the insert a
 *       no-op (returns inserted=false) — the orphan stays orphaned.
 *   (b) We want a 'reattach' audit shape (not 'couple_minted' nor
 *       'channel_scoped_bridged') so the operator can distinguish
 *       live-cascade matches from post-hoc reattach sweeps.
 *
 * The audit INSERT on `couple_merge_events` IS a guarded table (per
 * the cascade-only-writer GUARDED_TABLES list at line 87). To honour
 * the doctrine, this script lives in `scripts/` — the guard scans
 * `src/` only (see check-cascade-only-writer.mjs:81 SRC_DIR = src).
 * Operator-driven backfill scripts are outside the guard's surface,
 * matching the pattern set by:
 *   - scripts/backfill-couples-bridge.ts       (couples UPSERT via mirror)
 *   - scripts/backfill-high-tier-merges.ts     (mergeWeddings cascade)
 *   - scripts/reattach-orphan-interactions.ts  (interactions UPDATE)
 * All three are operator-invoked sweeps, never run in live request
 * paths. The same applies here.
 *
 * The CANDIDATE_MATCHES insert is NOT a guarded table — it's only an
 * operator-review queue, not part of the spine. No special handling.
 *
 * USAGE
 * -----
 *   # Dry-run against the persistent branch (recommended first pass):
 *   BRANCH_URL=https://ciwqxwohczzthvzqqgjx.supabase.co \
 *   BRANCH_KEY=<service_role_key_for_branch> \
 *   npx tsx scripts/reattach-couple-author-orphans.ts
 *
 *   # Dry-run against prod (read-only inspection of dispositions):
 *   BRANCH_URL=https://jsxxgwprxuqgcauzlxcb.supabase.co \
 *   BRANCH_KEY=<prod_service_role_key> \
 *   npx tsx scripts/reattach-couple-author-orphans.ts
 *
 *   # Apply against a NON-prod branch:
 *   BRANCH_URL=https://ciwqxwohczzthvzqqgjx.supabase.co \
 *   BRANCH_KEY=<service_role_key_for_branch> \
 *   npx tsx scripts/reattach-couple-author-orphans.ts --apply
 *
 *   # Apply against prod (operator opt-in):
 *   BRANCH_URL=https://jsxxgwprxuqgcauzlxcb.supabase.co \
 *   BRANCH_KEY=<prod_service_role_key> \
 *   npx tsx scripts/reattach-couple-author-orphans.ts --apply --allow-prod
 *
 *   # Scope to a specific venue (default: all venues):
 *   REATTACH_VENUE_ID=<uuid> npx tsx scripts/reattach-couple-author-orphans.ts
 *
 * VERIFIED SCHEMA FACTS (2026-05-26 prod)
 * ---------------------------------------
 * - `touchpoints` (mig 346): id, venue_id, couple_id (nullable),
 *   channel, signal_tier, action_type, external_id, occurred_at,
 *   raw_payload (jsonb). No author_class column; no wedding_id column.
 * - `interactions` (mig 293): author_class TEXT NOT NULL DEFAULT
 *   'unknown' with CHECK('couple', 'operator', 'sage',
 *   'platform_system', 'vendor', 'unknown').
 * - touchpoints from the live cascade store raw_payload.interaction_id
 *   pointing back at the source `interactions.id`. That field is how
 *   we join the two tables.
 * - `candidate_matches` (mig 346 + mig 360): record_type IN
 *   ('couple','fragment','channel_scoped','touchpoint'). The
 *   secondary side is the touchpoint, primary side is the couple.
 * - `couple_merge_events.event_type` (mig 366 + mig 374): includes
 *   'reattach' after mig 374 lands.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  cascadeMatch,
  describeMatch,
  type CascadeSignal,
  type CascadeCandidate,
} from '../src/lib/services/identity/identity-cascade'
import {
  scoreCandidate,
  type MatcherVerdict,
} from '../src/lib/services/identity/matcher'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')

/** Optional venue scope. Default: all venues. */
const VENUE_SCOPE = process.env.REATTACH_VENUE_ID || null

/** Known production project ref. The sweep refuses to WRITE against
 *  this url unless --allow-prod is passed. Mirrors backfill-couples-
 *  bridge.ts §Config. Dry-runs against prod are allowed (read-only). */
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'

/** Max couples to load per venue for cascade candidate set. The live
 *  linker uses 2000 (loadRecentCouples). Same bound here for parity. */
const MAX_COUPLES_PER_VENUE = 2000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TouchpointRow {
  id: string
  venue_id: string
  channel: string
  signal_tier: string
  action_type: string
  external_id: string
  occurred_at: string
  raw_payload: Record<string, unknown> | null
}

interface InteractionRow {
  id: string
  venue_id: string
  wedding_id: string | null
  person_id: string | null
  author_class: string
  type: string
  direction: string | null
  subject: string | null
  body_preview: string | null
  full_body: string | null
  from_email: string | null
  from_name: string | null
  to_email: string | null
  gmail_message_id: string | null
  gmail_thread_id: string | null
  timestamp: string | null
  extracted_identity: ExtractedIdentity | null
}

interface ExtractedIdentity {
  names?: string[] | null
  emails?: string[] | null
  phones?: string[] | null
  primary_email?: string | null
}

interface PersonRow {
  id: string
  venue_id: string
  wedding_id: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
}

interface CoupleRow {
  id: string
  venue_id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  partner_contact_name: string | null
  partner_contact_email: string | null
  partner_contact_phone: string | null
  wedding_date: string | null
  source_wedding_id: string | null
}

type Disposition =
  | { tier: 1; reason: string; coupleId: string; stage: string; evidence: string }
  | { tier: 2; reason: string; coupleId: string; verdict: MatcherVerdict }
  | { tier: 0; reason: string }

interface OrphanCase {
  tp: TouchpointRow
  ix: InteractionRow
  person: PersonRow | null
  disposition: Disposition
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitName(name: string | null | undefined): { first: string | null; last: string | null } {
  if (!name) return { first: null, last: null }
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: null, last: null }
  if (parts.length === 1) return { first: parts[0], last: null }
  return { first: parts[0], last: parts[parts.length - 1] }
}

/** Build a CascadeSignal from an interaction + touchpoint pair. We
 *  pull body text from full_body if available (interaction.full_body)
 *  else body_preview from the raw_payload, and use extracted_identity
 *  for body_emails / body_phones (already extracted upstream). */
function buildSignalFromInteraction(
  tp: TouchpointRow,
  ix: InteractionRow,
  person: PersonRow | null,
): CascadeSignal {
  const fromName = splitName(ix.from_name)
  // If from_name didn't yield a last name but the person row does,
  // prefer the person's last name. (Common shape: from_name='Melissa'
  // with person carrying last_name='Millis'.)
  const lastName = fromName.last ?? person?.last_name ?? null
  const firstName = fromName.first ?? person?.first_name ?? null

  const bodyText = ix.full_body || ix.body_preview || (tp.raw_payload?.['body_preview'] as string | undefined) || ''

  const ei: ExtractedIdentity = ix.extracted_identity ?? {}
  const bodyEmails = (ei.emails ?? []).filter((e): e is string => Boolean(e))
  const bodyPhones = (ei.phones ?? []).filter((p): p is string => Boolean(p))

  return {
    primaryEmail: ix.from_email ?? person?.email ?? null,
    primaryPhone: person?.phone ?? null,
    firstName,
    lastName,
    // No partner field on inbound emails today — leave null.
    partnerFirstName: null,
    partnerLastName: null,
    bodyText,
    weddingDate: null,
    bodyEmails,
    bodyPhones,
  }
}

function coupleToCascadeCandidate(c: CoupleRow): CascadeCandidate {
  const people: CascadeCandidate['people'] = []
  const primaryName = splitName(c.primary_contact_name)
  people.push({
    firstName: primaryName.first,
    lastName: primaryName.last,
    email: c.primary_contact_email,
    phone: c.primary_contact_phone,
  })
  const partnerName = splitName(c.partner_contact_name)
  people.push({
    firstName: partnerName.first,
    lastName: partnerName.last,
    email: c.partner_contact_email,
    phone: c.partner_contact_phone,
  })
  return {
    coupleId: c.id,
    weddingDate: c.wedding_date,
    people,
  }
}

function coupleToMatchableRecord(c: CoupleRow) {
  return {
    id: c.id,
    primary_name: c.primary_contact_name,
    partner_name: c.partner_contact_name,
    primary_email: c.primary_contact_email,
    partner_email: c.partner_contact_email,
    primary_phone: c.primary_contact_phone,
    partner_phone: c.partner_contact_phone,
    wedding_date: c.wedding_date,
  }
}

function signalToMatchableRecord(tp: TouchpointRow, ix: InteractionRow, person: PersonRow | null) {
  const fromName = splitName(ix.from_name)
  return {
    id: tp.external_id,
    primary_name: ix.from_name ?? (person ? `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() : null) ?? null,
    partner_name: null,
    primary_email: ix.from_email ?? person?.email ?? null,
    partner_email: null,
    primary_phone: person?.phone ?? null,
    partner_phone: null,
    wedding_date: null,
    observed_at: tp.occurred_at,
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadOrphanTouchpoints(
  sb: SupabaseClient,
  venueScope: string | null,
): Promise<TouchpointRow[]> {
  const PAGE = 1000
  const out: TouchpointRow[] = []
  for (let from = 0; ; from += PAGE) {
    let q = sb
      .from('touchpoints')
      .select('id, venue_id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload')
      .is('couple_id', null)
      .eq('channel', 'gmail')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (venueScope) q = q.eq('venue_id', venueScope)
    const { data, error } = await q
    if (error) throw new Error(`touchpoints: ${error.message}`)
    out.push(...((data ?? []) as TouchpointRow[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

async function loadInteractions(
  sb: SupabaseClient,
  ids: string[],
): Promise<Map<string, InteractionRow>> {
  const out = new Map<string, InteractionRow>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data, error } = await sb
      .from('interactions')
      .select(
        'id, venue_id, wedding_id, person_id, author_class, type, direction, subject, body_preview, full_body, from_email, from_name, to_email, gmail_message_id, gmail_thread_id, timestamp, extracted_identity',
      )
      .in('id', chunk)
    if (error) throw new Error(`interactions: ${error.message}`)
    for (const r of (data ?? []) as InteractionRow[]) out.set(r.id, r)
  }
  return out
}

async function loadPeople(
  sb: SupabaseClient,
  ids: string[],
): Promise<Map<string, PersonRow>> {
  const out = new Map<string, PersonRow>()
  if (ids.length === 0) return out
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data, error } = await sb
      .from('people')
      .select('id, venue_id, wedding_id, first_name, last_name, email, phone')
      .in('id', chunk)
    if (error) throw new Error(`people: ${error.message}`)
    for (const r of (data ?? []) as PersonRow[]) out.set(r.id, r)
  }
  return out
}

async function loadCouplesForVenue(
  sb: SupabaseClient,
  venueId: string,
): Promise<CoupleRow[]> {
  const { data, error } = await sb
    .from('couples')
    .select(
      'id, venue_id, primary_contact_name, primary_contact_email, primary_contact_phone, partner_contact_name, partner_contact_email, partner_contact_phone, wedding_date, source_wedding_id',
    )
    .eq('venue_id', venueId)
    .order('updated_at', { ascending: false })
    .limit(MAX_COUPLES_PER_VENUE)
  if (error) throw new Error(`couples: ${error.message}`)
  return (data ?? []) as CoupleRow[]
}

// ---------------------------------------------------------------------------
// Disposition logic — cascade first, then matcher fallback.
// ---------------------------------------------------------------------------

function disposeOne(
  tp: TouchpointRow,
  ix: InteractionRow,
  person: PersonRow | null,
  candidates: CascadeCandidate[],
  couples: CoupleRow[],
): Disposition {
  if (candidates.length === 0) {
    return { tier: 0, reason: 'venue has no couples loaded (cold-start)' }
  }
  const signal = buildSignalFromInteraction(tp, ix, person)
  const result = cascadeMatch(signal, candidates)
  if (result.matched) {
    return {
      tier: 1,
      reason: describeMatch(result),
      coupleId: result.coupleId,
      stage: result.stage,
      evidence: result.evidence,
    }
  }

  // Fall through to scoreCandidate for Tier 2 (medium/low).
  const sigRecord = signalToMatchableRecord(tp, ix, person)
  let best: { coupleId: string; verdict: MatcherVerdict } | null = null
  for (const c of couples) {
    const v = scoreCandidate(sigRecord, coupleToMatchableRecord(c))
    if (!best || v.score > best.verdict.score) best = { coupleId: c.id, verdict: v }
  }
  if (best && (best.verdict.tier === 'medium' || best.verdict.tier === 'low')) {
    return {
      tier: 2,
      reason: `score=${best.verdict.score} tier=${best.verdict.tier} — ${best.verdict.reason}`,
      coupleId: best.coupleId,
      verdict: best.verdict,
    }
  }
  return {
    tier: 0,
    reason: best
      ? `best score=${best.verdict.score} tier=${best.verdict.tier} (below queue threshold)`
      : 'no candidate scored',
  }
}

// ---------------------------------------------------------------------------
// Writers — only invoked under --apply.
// ---------------------------------------------------------------------------

async function applyTier1(
  sb: SupabaseClient,
  oc: OrphanCase,
): Promise<{ ok: boolean; error?: string }> {
  if (oc.disposition.tier !== 1) {
    return { ok: false, error: 'not a Tier 1 disposition' }
  }
  // 1. UPDATE touchpoints.couple_id. Idempotent — if already set
  // (re-run race), we leave it; the WHERE on couple_id IS NULL is the
  // safety net so we never overwrite a different bind.
  const { error: upErr } = await sb
    .from('touchpoints')
    .update({ couple_id: oc.disposition.coupleId })
    .eq('id', oc.tp.id)
    .is('couple_id', null) // safety: don't overwrite a re-bound row
  if (upErr) return { ok: false, error: `touchpoint update: ${upErr.message}` }

  // 2. INSERT audit row. event_type='reattach' depends on mig 374.
  const { error: auditErr } = await sb.from('couple_merge_events').insert({
    venue_id: oc.tp.venue_id,
    event_type: 'reattach',
    primary_couple_id: oc.disposition.coupleId,
    secondary_couple_id: null,
    operator_id: null,
    rule_triggered: `reattach_couple_author_orphan.${oc.disposition.stage}`,
    confidence_tier: 'high',
    reason: `reattach orphan touchpoint ${oc.tp.id} from interaction ${oc.ix.id} — ${oc.disposition.evidence}`,
  })
  if (auditErr) {
    // The touchpoint is already updated; surface the audit miss but
    // do not roll back. Constitution: the audit row is best-effort
    // observability, not a transactional gate.
    return { ok: true, error: `audit insert failed (non-fatal): ${auditErr.message}` }
  }
  return { ok: true }
}

async function applyTier2(
  sb: SupabaseClient,
  oc: OrphanCase,
): Promise<{ ok: boolean; error?: string }> {
  if (oc.disposition.tier !== 2) {
    return { ok: false, error: 'not a Tier 2 disposition' }
  }
  // candidate_matches: primary=couple (the proposed match), secondary=touchpoint.
  const { error } = await sb.from('candidate_matches').insert({
    venue_id: oc.tp.venue_id,
    primary_record_id: oc.disposition.coupleId,
    primary_record_type: 'couple',
    secondary_record_id: oc.tp.id,
    secondary_record_type: 'touchpoint',
    confidence_tier: oc.disposition.verdict.tier === 'medium' ? 'medium' : 'low',
    matcher_reason: `reattach-sweep: ${oc.disposition.reason}`,
  })
  if (error) {
    // 23505 = duplicate enqueue; idempotent no-op.
    if (error.code === '23505') return { ok: true }
    return { ok: false, error: `candidate insert: ${error.message}` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.BRANCH_URL
  const key = process.env.BRANCH_KEY
  if (!url || !key) {
    console.error(
      'ERROR: BRANCH_URL and BRANCH_KEY must be set in the environment.\n' +
        'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> ' +
        'npx tsx scripts/reattach-couple-author-orphans.ts [--apply] [--allow-prod]',
    )
    process.exit(1)
  }
  if (APPLY && url.includes(PROD_REF) && !ALLOW_PROD) {
    console.error(
      `ERROR: BRANCH_URL points at production (${PROD_REF}) and --apply was set.\n` +
        'Pass --allow-prod to override. Dry-runs against prod are allowed without that flag.',
    )
    process.exit(1)
  }

  const sb: SupabaseClient = createClient(url, key, { auth: { persistSession: false } })

  const isProd = url.includes(PROD_REF)
  const mode = APPLY ? (isProd ? '[APPLY · PROD]' : '[APPLY]') : '[DRY-RUN]'
  console.log('='.repeat(78))
  console.log(`${mode} reattach-couple-author-orphans`)
  console.log('='.repeat(78))
  console.log(`Target DB    : ${url}`)
  console.log(`Venue scope  : ${VENUE_SCOPE ?? '(all venues)'}`)
  console.log('')

  // 1. Load all orphan gmail touchpoints.
  console.log('[1] Loading orphan gmail touchpoints (couple_id IS NULL)…')
  const allOrphans = await loadOrphanTouchpoints(sb, VENUE_SCOPE)
  console.log(`    total orphan gmail touchpoints: ${allOrphans.length}`)

  // 2. Join via raw_payload.interaction_id → interactions; keep only author=couple.
  const iids = Array.from(
    new Set(
      allOrphans
        .map((t) => (t.raw_payload?.['interaction_id'] as string | undefined) ?? null)
        .filter((v): v is string => Boolean(v)),
    ),
  )
  console.log(`    interaction ids referenced     : ${iids.length}`)

  const ixMap = await loadInteractions(sb, iids)
  const coupleAuthorPairs: Array<{ tp: TouchpointRow; ix: InteractionRow }> = []
  for (const tp of allOrphans) {
    const iid = tp.raw_payload?.['interaction_id'] as string | undefined
    if (!iid) continue
    const ix = ixMap.get(iid)
    if (!ix) continue
    if (ix.author_class !== 'couple') continue
    coupleAuthorPairs.push({ tp, ix })
  }
  console.log(`    couple-author orphans          : ${coupleAuthorPairs.length}`)
  if (coupleAuthorPairs.length === 0) {
    console.log('\nNothing to do. Exiting.')
    return
  }

  // 3. Load person rows referenced by these interactions.
  const personIds = Array.from(
    new Set(coupleAuthorPairs.map((p) => p.ix.person_id).filter((v): v is string => Boolean(v))),
  )
  const peopleMap = await loadPeople(sb, personIds)
  console.log(`    distinct person_ids            : ${personIds.length}`)

  // 4. Load couples per venue (cascade candidates). Group by venue.
  const venueSet = new Set(coupleAuthorPairs.map((p) => p.tp.venue_id))
  console.log(`    venues involved                : ${venueSet.size}`)
  const couplesPerVenue = new Map<string, CoupleRow[]>()
  const candidatesPerVenue = new Map<string, CascadeCandidate[]>()
  for (const v of venueSet) {
    const couples = await loadCouplesForVenue(sb, v)
    couplesPerVenue.set(v, couples)
    candidatesPerVenue.set(v, couples.map(coupleToCascadeCandidate))
    console.log(`      venue ${v.slice(0, 8)}…  candidates: ${couples.length}`)
  }
  console.log('')

  // 5. Dispose each orphan.
  console.log('[2] Running cascade match…')
  const cases: OrphanCase[] = []
  for (const { tp, ix } of coupleAuthorPairs) {
    const person = ix.person_id ? peopleMap.get(ix.person_id) ?? null : null
    const candidates = candidatesPerVenue.get(tp.venue_id) ?? []
    const couples = couplesPerVenue.get(tp.venue_id) ?? []
    const disposition = disposeOne(tp, ix, person, candidates, couples)
    cases.push({ tp, ix, person, disposition })
  }

  // 6. Report breakdown.
  const tierCounts = { 1: 0, 2: 0, 0: 0 } as Record<0 | 1 | 2, number>
  const stageCounts: Record<string, number> = {}
  for (const c of cases) {
    tierCounts[c.disposition.tier] += 1
    if (c.disposition.tier === 1) {
      stageCounts[c.disposition.stage] = (stageCounts[c.disposition.stage] ?? 0) + 1
    }
  }
  console.log('')
  console.log('-'.repeat(78))
  console.log('DISPOSITION BREAKDOWN')
  console.log('-'.repeat(78))
  console.log(`  Tier 1 (auto-bind, deterministic)  : ${tierCounts[1]}`)
  console.log(`  Tier 2 (enqueue candidate_match)   : ${tierCounts[2]}`)
  console.log(`  Tier 0 (no match — leave alone)    : ${tierCounts[0]}`)
  if (tierCounts[1] > 0) {
    console.log('')
    console.log('  Tier 1 by cascade stage:')
    for (const [k, n] of Object.entries(stageCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(34)}: ${n}`)
    }
  }
  console.log('')

  // 7. Sample rows per disposition (helpful for the operator's review).
  console.log('-'.repeat(78))
  console.log('SAMPLE ROWS')
  console.log('-'.repeat(78))
  const tier1Samples = cases.filter((c) => c.disposition.tier === 1).slice(0, 8)
  const tier2Samples = cases.filter((c) => c.disposition.tier === 2).slice(0, 8)
  const tier0Samples = cases.filter((c) => c.disposition.tier === 0).slice(0, 8)
  if (tier1Samples.length > 0) {
    console.log('\nTier 1 — would AUTO-BIND:')
    for (const c of tier1Samples) {
      const d = c.disposition as Extract<Disposition, { tier: 1 }>
      console.log(
        `  tp=${c.tp.id.slice(0, 8)}…  ix=${c.ix.id.slice(0, 8)}…  from=${(c.ix.from_email ?? '-').slice(0, 38).padEnd(38)}  name="${(c.ix.from_name ?? '').slice(0, 22).padEnd(22)}"  → couple ${d.coupleId.slice(0, 8)}…  via ${d.stage}`,
      )
    }
  }
  if (tier2Samples.length > 0) {
    console.log('\nTier 2 — would ENQUEUE candidate_match:')
    for (const c of tier2Samples) {
      const d = c.disposition as Extract<Disposition, { tier: 2 }>
      console.log(
        `  tp=${c.tp.id.slice(0, 8)}…  ix=${c.ix.id.slice(0, 8)}…  from=${(c.ix.from_email ?? '-').slice(0, 38).padEnd(38)}  → propose couple ${d.coupleId.slice(0, 8)}…  ${d.reason.slice(0, 80)}`,
      )
    }
  }
  if (tier0Samples.length > 0) {
    console.log('\nTier 0 — NO MATCH (operator review may be needed):')
    for (const c of tier0Samples) {
      console.log(
        `  tp=${c.tp.id.slice(0, 8)}…  ix=${c.ix.id.slice(0, 8)}…  from=${(c.ix.from_email ?? '-').slice(0, 38).padEnd(38)}  name="${(c.ix.from_name ?? '').slice(0, 22).padEnd(22)}"  subj="${(c.ix.subject ?? '').slice(0, 36)}"  reason: ${c.disposition.reason}`,
      )
    }
  }
  console.log('')

  if (!APPLY) {
    console.log('-'.repeat(78))
    console.log('DRY-RUN — no writes performed.')
    console.log(`Re-run with --apply${isProd ? ' --allow-prod' : ''} to bind Tier 1 rows + enqueue Tier 2 candidates.`)
    console.log('-'.repeat(78))
    return
  }

  // 8. Apply.
  console.log('-'.repeat(78))
  console.log(`APPLYING — binding ${tierCounts[1]} Tier 1 rows + enqueuing ${tierCounts[2]} Tier 2 candidates…`)
  console.log('-'.repeat(78))

  let t1Ok = 0
  let t1Fail = 0
  let t2Ok = 0
  let t2Fail = 0
  const failures: string[] = []

  for (const c of cases) {
    if (c.disposition.tier === 1) {
      const r = await applyTier1(sb, c)
      if (r.ok) {
        t1Ok += 1
        if (r.error) failures.push(`tp=${c.tp.id.slice(0, 8)}: ${r.error}`)
      } else {
        t1Fail += 1
        failures.push(`tp=${c.tp.id.slice(0, 8)}: ${r.error}`)
      }
    } else if (c.disposition.tier === 2) {
      const r = await applyTier2(sb, c)
      if (r.ok) t2Ok += 1
      else {
        t2Fail += 1
        failures.push(`tp=${c.tp.id.slice(0, 8)}: ${r.error}`)
      }
    }
  }

  console.log('')
  console.log('='.repeat(78))
  console.log('RESULT')
  console.log('='.repeat(78))
  console.log(`  Tier 1 bound          : ${t1Ok} / ${tierCounts[1]}  (failed: ${t1Fail})`)
  console.log(`  Tier 2 enqueued       : ${t2Ok} / ${tierCounts[2]}  (failed: ${t2Fail})`)
  console.log(`  Tier 0 left alone     : ${tierCounts[0]}`)
  if (failures.length > 0) {
    console.log('')
    console.log('FAILURES (first 20):')
    for (const f of failures.slice(0, 20)) console.log(`  ${f}`)
  }
  console.log('='.repeat(78))
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
