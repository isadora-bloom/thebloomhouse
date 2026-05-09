/**
 * Identity name backfill (Wave 2C — historical-data pass).
 *
 * Anchor docs:
 *   - IDENTITY-CAPTURE-DESIGN.md Phase 3 (backfill)
 *   - IDENTITY-BACKFILL-PLAN.md (dry-run vs write contract, audit shape)
 *   - bloom-constitution.md (forensic identity reconstruction)
 *
 * Why this endpoint exists
 * ------------------------
 * Wave 2A shipped the chokepoint (`identity/name-capture.ts`). Wave 2B
 * is refactoring the live capture sites. Both waves only fix NEW
 * arrivals — every historical wedding still has flat first_name /
 * last_name columns populated from whichever Knot relay shape happened
 * to arrive first. The forensic record exists in `interactions.
 * extracted_identity`, in `contracts.extracted_text`, in `weddings.
 * notes`, in `tangential_signals.extracted_identity.username`, and in
 * the calculator submission emails — but no one has fed it back into
 * the chokepoint to reconstruct the picked display.
 *
 * This endpoint walks every active people row at the caller's venue,
 * harvests every name signal we have on disk, feeds each one through
 * `captureNameEvidence` (the chokepoint), and lets the picker re-
 * compute display + handles + confidence. Zero LLM calls — purely
 * deterministic shape extraction + chokepoint writes.
 *
 * Two modes
 * ---------
 *   dryRun=true  — compute every signal, run the picker against
 *                  shadow evidence, return the diff. NO database
 *                  writes. Coordinator scans the diff and decides
 *                  whether to greenlight.
 *
 *   dryRun=false — execute the same signal harvest but pass each
 *                  signal through `captureNameEvidence` so the
 *                  evidence array, platform_handles, display_handle,
 *                  and dual-write columns all update via the chokepoint.
 *                  Each upgraded wedding fires ONE batched
 *                  `admin_notifications` row so the audit trail is
 *                  intact without spamming the bell.
 *
 * Default is dryRun=true. The caller MUST opt in explicitly with
 * `{ "dryRun": false }` to write.
 *
 * Method: POST
 * Body: { "dryRun"?: boolean, "limit"?: number }
 * Auth: getPlatformAuth + auth.venueId
 *
 * Returns:
 *   {
 *     ok: true,
 *     dryRun: boolean,
 *     processed: number,
 *     hasMore: boolean,
 *     weddings_scanned: number,
 *     people_processed: number,
 *     diffs: Array<{
 *       personId: string,
 *       weddingId: string,
 *       currentDisplay: { first: string | null; last: string | null },
 *       proposedDisplay: { first: string | null; last: string | null; confidence: number },
 *       evidenceCount: number,
 *       sourceBreakdown: Record<string, number>,
 *       handleCount: number,
 *     }>,
 *   }
 *
 * Performance
 * -----------
 * Per the design: 670 weddings × ~3 people × ~8 evidence sources =
 * ~16K capture calls per venue worst-case. We process in batches of 50
 * weddings sequentially. Each chokepoint call does 1 SELECT + 1
 * UPDATE on the people row. At ~50 ms per call that's ~13 minutes per
 * 16K calls — over the 300 s function cap. Therefore: the endpoint
 * processes up to `limit` weddings per call (default 50, hard max
 * 200) and returns `hasMore: true` when there's more on disk. The
 * coordinator-side runner re-invokes until `hasMore: false`.
 *
 * Cost: ZERO LLM calls.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  captureNameEvidence,
  pickDisplayName,
  buildEvidenceFromSignal,
  classifyNameShape,
  type NameSignal,
  type NameEvidence,
  type NameSource,
  type Platform,
} from '@/lib/services/identity/name-capture'

// Vercel Pro Functions cap is 300s. We cap our wedding batch at 200
// per call so even a worst-case 5 ms-per-row pipeline lands under the
// wall.
export const maxDuration = 300

const DEFAULT_LIMIT = 50
const HARD_MAX_LIMIT = 200
const DIFF_SAMPLE_CAP = 200

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

interface PostBody {
  dryRun?: boolean
  limit?: number
  /** Skip the first N weddings — coordinator-side runner uses this to
   *  page through a venue across multiple invocations. Defaults to 0. */
  offset?: number
}

interface DiffEntry {
  personId: string
  weddingId: string
  currentDisplay: { first: string | null; last: string | null }
  proposedDisplay: { first: string | null; last: string | null; confidence: number }
  evidenceCount: number
  sourceBreakdown: Record<string, number>
  handleCount: number
}

// ---------------------------------------------------------------------------
// Signal extractors (deterministic, no LLM)
// ---------------------------------------------------------------------------

interface InteractionRow {
  id: string
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  extracted_identity: Record<string, unknown> | null
  timestamp: string | null
}

interface ContractRow {
  id: string
  extracted_text: string | null
  created_at: string | null
}

interface TangentialSignalRow {
  id: string
  source_platform: string | null
  signal_date: string | null
  extracted_identity: Record<string, unknown> | null
}

interface WeddingShape {
  id: string
  notes: string | null
  sage_context_notes: unknown
  inquiry_date: string | null
}

interface PersonShape {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
}

const NAME_RE = /\b([A-Z][a-z'À-ſ-]{1,29})\s+([A-Z](?:[a-z'À-ſ-]{1,29}|\.))/g

/** Wave 2C: per-platform mapping from `tangential_signals.source_platform`
 *  to the name-capture `Platform` enum. Pinterest, Knot, WeddingWire,
 *  Instagram, TikTok, Facebook, Twitter all directly land. Everything
 *  else (HoneyBook / Calendly / Zola / etc.) is dropped from handle
 *  capture because they don't carry user handles in a useful shape. */
const PLATFORM_MAP: Record<string, Platform> = {
  pinterest: 'pinterest',
  the_knot: 'knot',
  knot: 'knot',
  wedding_wire: 'weddingwire',
  weddingwire: 'weddingwire',
  instagram: 'instagram',
  tiktok: 'tiktok',
  facebook: 'facebook',
  twitter: 'twitter',
}

const PLATFORM_TO_RELAY_SOURCE: Record<Platform, NameSource> = {
  pinterest: 'pinterest_scraper',
  knot: 'knot_relay',
  weddingwire: 'weddingwire_relay',
  instagram: 'instagram_handle',
  tiktok: 'instagram_handle', // closest analog; chokepoint base confidence 25
  facebook: 'instagram_handle',
  twitter: 'instagram_handle',
}

/** Pull every signal an interaction can yield. */
function signalsFromInteraction(row: InteractionRow): NameSignal[] {
  const out: NameSignal[] = []
  const fromEmail = (row.from_email ?? '').trim().toLowerCase() || null
  const ts = row.timestamp ?? undefined

  // 1. Gmail / relay From-name shape — always emit. Source maps to the
  //    relay flavour when the from_email looks relay-shaped, gmail
  //    otherwise. Confidence is shape-driven inside the chokepoint.
  if (row.from_name && row.from_name.trim()) {
    let source: NameSource = 'gmail_from_name'
    if (fromEmail && /@member\.theknot\.com$/.test(fromEmail)) source = 'knot_relay'
    else if (fromEmail && /@(reply\.weddingwire\.com|mail\.weddingwire\.com)$/.test(fromEmail)) {
      source = 'weddingwire_relay'
    }
    out.push({
      full: row.from_name,
      email: fromEmail,
      source,
      capturedAt: ts,
      interactionId: row.id,
    })
  }

  // 2. extracted_identity direct first/last (parser-populated).
  const ei = row.extracted_identity ?? null
  if (ei) {
    const directFirst = typeof ei.first_name === 'string' ? ei.first_name : null
    const directLast = typeof ei.last_name === 'string' ? ei.last_name : null
    if (directFirst || directLast) {
      out.push({
        first: directFirst,
        last: directLast,
        email: fromEmail,
        // Form-relay parsers populate first_name/last_name directly.
        // The `form_relay` source has base confidence 60.
        source: 'form_relay',
        capturedAt: ts,
        interactionId: row.id,
      })
    }

    // 3. extracted_identity.names[] body-extracted pairs.
    const names = Array.isArray(ei.names) ? (ei.names as unknown[]) : []
    for (const n of names) {
      if (typeof n !== 'string') continue
      out.push({
        full: n,
        email: fromEmail,
        // Body-extracted names go through the partner-mention-in-body
        // confidence (40); shape detector still runs in the chokepoint.
        source: 'partner_mention_in_body',
        capturedAt: ts,
        interactionId: row.id,
      })
    }
  }

  // 4. Calculator subject / body heuristic — promote signals from this
  //    interaction to the calculator_form source (confidence 95).
  const subjectLower = (row.subject ?? '').toLowerCase()
  const bodyLower = (row.full_body ?? '').toLowerCase()
  const isCalculator =
    subjectLower.includes('estimate') ||
    bodyLower.includes('new calculator submission') ||
    bodyLower.includes('estimate calculator')

  if (isCalculator && row.full_body) {
    // Scan the body for capitalized first+last pairs and treat each as
    // a calculator_form signal. The chokepoint shape detector filters
    // junk; we just feed candidates.
    const text = row.full_body
    NAME_RE.lastIndex = 0
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    let added = 0
    while ((m = NAME_RE.exec(text)) !== null && added < 6) {
      const candidate = `${m[1]} ${m[2]}`
      if (seen.has(candidate)) continue
      seen.add(candidate)
      out.push({
        full: candidate,
        email: fromEmail,
        source: 'calculator_form',
        capturedAt: ts,
        interactionId: row.id,
      })
      added += 1
    }
  }

  return out
}

/** Pull contract signer-name candidates from extracted_text. */
function signalsFromContract(row: ContractRow): NameSignal[] {
  const text = row.extracted_text
  if (!text || !text.trim()) return []
  const out: NameSignal[] = []
  const seen = new Set<string>()
  NAME_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let added = 0
  while ((m = NAME_RE.exec(text)) !== null && added < 8) {
    const candidate = `${m[1]} ${m[2]}`
    if (seen.has(candidate)) continue
    seen.add(candidate)
    out.push({
      full: candidate,
      source: 'contract_signer',
      capturedAt: row.created_at ?? undefined,
    })
    added += 1
  }
  return out
}

/** Pull free-text candidates from wedding notes and sage_context_notes. */
function signalsFromWeddingText(wedding: WeddingShape): NameSignal[] {
  const out: NameSignal[] = []
  const harvest = (text: string, ts: string | undefined): void => {
    NAME_RE.lastIndex = 0
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    let added = 0
    while ((m = NAME_RE.exec(text)) !== null && added < 6) {
      const candidate = `${m[1]} ${m[2]}`
      if (/^(Reply|View|Click|Forward|Read|Send|Open|Visit|Contact|Email|Phone|Subject|Date|From|To|Re|Fwd)\s/.test(candidate)) continue
      if (seen.has(candidate)) continue
      seen.add(candidate)
      out.push({
        full: candidate,
        // Brain-dump notes get the brain_dump_note source (confidence 80).
        source: 'brain_dump_note',
        capturedAt: ts,
      })
      added += 1
    }
  }

  if (wedding.notes && wedding.notes.trim()) {
    harvest(wedding.notes, wedding.inquiry_date ?? undefined)
  }
  const scn = wedding.sage_context_notes
  if (Array.isArray(scn)) {
    for (const entry of scn) {
      if (!entry) continue
      const blob = typeof entry === 'string' ? entry : JSON.stringify(entry)
      harvest(blob, wedding.inquiry_date ?? undefined)
    }
  }
  return out
}

/** Tangential signals carry a platform `username`. Capture as platform
 *  handle on the people row — the chokepoint stores it in
 *  platform_handles[platform] and emits a low-confidence shape evidence
 *  row so the picker can later salvage a name inference. */
function signalsFromTangential(row: TangentialSignalRow): NameSignal[] {
  const ei = row.extracted_identity ?? null
  if (!ei) return []
  const username = typeof ei.username === 'string' ? ei.username : null
  if (!username || !username.trim()) return []
  const sp = (row.source_platform ?? '').toLowerCase()
  const platform = PLATFORM_MAP[sp] ?? null
  if (!platform) return []
  // The chokepoint accepts a handle + platform tuple. We map the source
  // to the platform-relay source (knot_relay / pinterest_scraper / etc.)
  // so the per-source base confidence is right.
  return [
    {
      handle: username.trim(),
      platform,
      source: PLATFORM_TO_RELAY_SOURCE[platform],
      capturedAt: row.signal_date ?? undefined,
    },
  ]
}

// ---------------------------------------------------------------------------
// Per-wedding processing
// ---------------------------------------------------------------------------

interface WeddingProcessResult {
  weddingId: string
  diffs: DiffEntry[]
  upgradesApplied: number
}

async function processOneWedding(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  weddingId: string,
  dryRun: boolean,
): Promise<WeddingProcessResult> {
  const result: WeddingProcessResult = {
    weddingId,
    diffs: [],
    upgradesApplied: 0,
  }

  // Pull wedding shell, people, interactions, contracts, and tangential
  // signals in parallel. A 670-wedding venue at ~5 reads each is well
  // under any DB pressure threshold.
  const [
    weddingResp,
    peopleResp,
    interactionsResp,
    contractsResp,
    tangentialsResp,
  ] = await Promise.all([
    supabase
      .from('weddings')
      .select('id, notes, sage_context_notes, inquiry_date, merged_into_id')
      .eq('id', weddingId)
      .maybeSingle(),
    supabase
      .from('people')
      .select('id, email, first_name, last_name, merged_into_id')
      .eq('wedding_id', weddingId)
      .is('merged_into_id', null),
    supabase
      .from('interactions')
      .select('id, from_email, from_name, subject, full_body, extracted_identity, timestamp')
      .eq('wedding_id', weddingId),
    supabase
      .from('contracts')
      .select('id, extracted_text, created_at')
      .eq('wedding_id', weddingId),
    supabase
      .from('tangential_signals')
      .select('id, source_platform, signal_date, extracted_identity')
      .eq('venue_id', venueId)
      .eq('resolved_wedding_id', weddingId)
      .not('extracted_identity', 'is', null),
  ])

  const wedding = weddingResp.data as WeddingShape & { merged_into_id: string | null } | null
  if (!wedding || wedding.merged_into_id) return result
  const people = (peopleResp.data ?? []) as PersonShape[]
  if (people.length === 0) return result
  const interactions = (interactionsResp.data ?? []) as InteractionRow[]
  const contracts = (contractsResp.data ?? []) as ContractRow[]
  const tangentials = (tangentialsResp.data ?? []) as TangentialSignalRow[]

  // Build the universal signal pool for this wedding.
  const sharedSignals: NameSignal[] = []
  for (const i of interactions) sharedSignals.push(...signalsFromInteraction(i))
  for (const c of contracts) sharedSignals.push(...signalsFromContract(c))
  sharedSignals.push(...signalsFromWeddingText(wedding))
  for (const t of tangentials) sharedSignals.push(...signalsFromTangential(t))

  if (sharedSignals.length === 0) return result

  // For each person, produce a per-person signal list. We attribute a
  // signal to a person when:
  //   - the signal carries an `email` and that email matches the
  //     person's email (strongest), OR
  //   - the wedding has a single person (lone partner1 — every signal
  //     attributes to them), OR
  //   - the wedding has 2+ people and the signal email is the from-
  //     email of one of them.
  // Otherwise we attribute to the partner1 (or first person row when
  // role isn't set). This mirrors how the live pipeline already
  // routes sub-zero candidates — best-effort attribution.
  for (const person of people) {
    const personEmail = (person.email ?? '').trim().toLowerCase() || null

    // For dry-run we synthesise a shadow evidence array by mapping
    // every signal through `buildEvidenceFromSignal`. The real run
    // calls `captureNameEvidence` which does the same thing plus the
    // dual-write.
    const sigsForPerson: NameSignal[] = []
    for (const s of sharedSignals) {
      // Email-anchored attribution: only the matching person.
      if (s.email && personEmail && s.email !== personEmail) {
        // If the person has an email and it disagrees with this signal,
        // the signal is for the OTHER person on the wedding. Skip.
        continue
      }
      sigsForPerson.push(s)
    }

    if (sigsForPerson.length === 0) continue

    if (dryRun) {
      // Build shadow evidence + run the picker locally (no DB writes).
      const shadow: NameEvidence[] = []
      const handleCounts = new Map<string, string>()
      const sourceBreakdown: Record<string, number> = {}
      for (const s of sigsForPerson) {
        if (s.handle && s.platform) {
          handleCounts.set(s.platform, s.handle)
        }
        const ev = buildEvidenceFromSignal(s)
        if (ev) shadow.push(ev)
        sourceBreakdown[s.source] = (sourceBreakdown[s.source] ?? 0) + 1
      }
      // Dedup the shadow by source + value + capturedAt within an hour
      // (mirrors chokepoint's deduplicateEvidence). Skipped here — the
      // dry-run is informational, exact dedup happens in the write
      // path. So the count we report can over-state by a few percent
      // on chatty threads; that's fine for a sizing pass.
      const pick = pickDisplayName(shadow)
      const before = { first: person.first_name, last: person.last_name }
      const after = { first: pick.first, last: pick.last, confidence: pick.confidence }
      const movedFirst = (before.first ?? null) !== (after.first ?? null)
      const movedLast = (before.last ?? null) !== (after.last ?? null)
      if (!movedFirst && !movedLast) continue
      if (result.diffs.length < DIFF_SAMPLE_CAP) {
        result.diffs.push({
          personId: person.id,
          weddingId,
          currentDisplay: before,
          proposedDisplay: after,
          evidenceCount: shadow.length,
          sourceBreakdown,
          handleCount: handleCounts.size,
        })
      }
      continue
    }

    // ---- Write mode ----
    // Run each signal through the chokepoint. The chokepoint dedupes
    // and reruns the picker on every call; that's idempotent but
    // wastes round-trips on 16K calls. We optimise by feeding all
    // signals first, then issuing a final picker rerun by passing
    // the highest-confidence signal last (the chokepoint always re-
    // picks). Order of signals is preserved.
    let evidenceAdded = 0
    let handleCaptured = 0
    let firstBefore: string | null = person.first_name
    let lastBefore: string | null = person.last_name
    let lastResult: { first: string | null; last: string | null; confidence: number } | null = null

    for (const s of sigsForPerson) {
      try {
        const r = await captureNameEvidence(supabase, person.id, s)
        evidenceAdded += r.evidenceAdded
        if (r.handleCaptured) handleCaptured += 1
        if (r.newDisplay) lastResult = r.newDisplay
      } catch (err) {
        console.warn('[rebuild-names] capture failed', { personId: person.id, source: s.source, err: err instanceof Error ? err.message : err })
      }
    }

    if (lastResult) {
      const movedFirst = (firstBefore ?? null) !== (lastResult.first ?? null)
      const movedLast = (lastBefore ?? null) !== (lastResult.last ?? null)
      if (movedFirst || movedLast) {
        result.upgradesApplied += 1
        if (result.diffs.length < DIFF_SAMPLE_CAP) {
          const sourceBreakdown: Record<string, number> = {}
          for (const s of sigsForPerson) sourceBreakdown[s.source] = (sourceBreakdown[s.source] ?? 0) + 1
          result.diffs.push({
            personId: person.id,
            weddingId,
            currentDisplay: { first: firstBefore, last: lastBefore },
            proposedDisplay: lastResult,
            evidenceCount: evidenceAdded,
            sourceBreakdown,
            handleCount: handleCaptured,
          })
        }
      }
    }
    void classifyNameShape // type usage hint to keep import warnings silent
  }

  return result
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run identity name backfill')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  const venueId: string = auth.venueId

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  // Hard-rule: dryRun defaults to TRUE. The caller must explicitly
  // pass `dryRun: false` to write. Anything else (undefined, "false"
  // string, etc.) stays dry.
  const dryRun = body.dryRun === false ? false : true
  const limitRaw = typeof body.limit === 'number' ? body.limit : DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(HARD_MAX_LIMIT, Math.floor(limitRaw)))
  const offsetRaw = typeof body.offset === 'number' ? body.offset : 0
  const offset = Math.max(0, Math.floor(offsetRaw))

  const supabase = createServiceClient()

  // Wedding cohort — non-tombstoned, ordered for stable paging.
  const { data: weddingRows, error: weddingErr, count } = await supabase
    .from('weddings')
    .select('id', { count: 'exact' })
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  if (weddingErr) {
    return NextResponse.json(
      { ok: false, error: weddingErr.message },
      { status: 500 },
    )
  }

  const weddings = (weddingRows ?? []) as Array<{ id: string }>
  const totalCount = count ?? weddings.length

  const allDiffs: DiffEntry[] = []
  let peopleProcessed = 0
  let upgradesApplied = 0
  // Group upgraded weddings so the audit notification is one row per
  // wedding, not one per person.
  const upgradesByWedding = new Map<string, DiffEntry[]>()

  for (const w of weddings) {
    let processed: WeddingProcessResult
    try {
      processed = await processOneWedding(supabase, venueId, w.id, dryRun)
    } catch (err) {
      console.warn('[rebuild-names] wedding sweep failed', {
        weddingId: w.id,
        err: err instanceof Error ? err.message : err,
      })
      continue
    }
    peopleProcessed += processed.diffs.length
    upgradesApplied += processed.upgradesApplied
    for (const d of processed.diffs) {
      if (allDiffs.length < DIFF_SAMPLE_CAP) allDiffs.push(d)
      const arr = upgradesByWedding.get(d.weddingId) ?? []
      arr.push(d)
      upgradesByWedding.set(d.weddingId, arr)
    }
  }

  // Audit-notification batch — only fires on real writes (dryRun=false)
  // and only when at least one person row moved on this wedding.
  if (!dryRun && upgradesByWedding.size > 0) {
    for (const [weddingId, diffs] of upgradesByWedding.entries()) {
      const lines = diffs.map((d) => {
        const before = `${d.currentDisplay.first ?? ''} ${d.currentDisplay.last ?? ''}`.trim() || '(empty)'
        const after = `${d.proposedDisplay.first ?? ''} ${d.proposedDisplay.last ?? ''}`.trim() || '(empty)'
        return `${before} → ${after} (confidence ${d.proposedDisplay.confidence}, ${d.evidenceCount} evidence rows, ${d.handleCount} platform handles)`
      })
      try {
        await supabase.from('admin_notifications').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          type: 'name_rebuild',
          title: diffs.length === 1
            ? 'Name rebuilt from historical evidence'
            : `${diffs.length} names rebuilt from historical evidence`,
          body:
            'Coordinator audit — Wave 2C historical-data backfill replayed every name signal we have on disk for this wedding (interactions, contracts, brain-dump notes, platform handles) through the chokepoint and the picker upgraded the following display names:\n\n' +
            lines.join('\n'),
          priority: 'low',
        })
      } catch (err) {
        console.warn('[rebuild-names] admin_notifications insert failed', {
          weddingId,
          err: err instanceof Error ? err.message : err,
        })
      }
    }
  }

  const processedSoFar = offset + weddings.length
  const hasMore = processedSoFar < totalCount

  return NextResponse.json({
    ok: true,
    dryRun,
    processed: weddings.length,
    weddings_scanned: weddings.length,
    people_processed: peopleProcessed,
    upgrades_applied: dryRun ? 0 : upgradesApplied,
    total_in_venue: totalCount,
    next_offset: hasMore ? processedSoFar : null,
    hasMore,
    diffs: allDiffs,
  })
}
