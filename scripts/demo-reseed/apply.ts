/**
 * demo-reseed — the applier.
 *
 * Walks a plan. In dry-run (the default) it touches nothing and returns
 * the counts it would have written. Under `--apply --allow-prod` it
 * deletes the demo venues' rows and replays every signal through
 * `linkSignal`, the one allowed writer.
 *
 * Writer discipline (ORIGIN-INGESTION-SPEC.md, CASCADE-CANONICAL-WRITER.md):
 * nothing in this file INSERTs into `couples`, `touchpoints`, `people` or
 * `weddings`. Creation goes through `mintWedding` and `linkSignal`, both
 * exported from `@/lib/spine/cascade`, plus `mirrorCoupleFromWedding`,
 * the canonical bridge those two already use between them. Everything
 * else this file writes is either an UPDATE (outside the creation
 * boundary) or a plain analytics row (`tours`, `lost_deals`,
 * `engagement_events`), none of which is guarded.
 *
 * Every writer is injected so a unit test can drive the whole walk with a
 * fake Supabase client and stub writers, and assert on what would have
 * been called, without a database anywhere near it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedSignal } from '../../src/lib/services/identity/sources/types'
import { AUX_FORBIDDEN_TABLES, COUPLE_REF_RE, WEDDING_REF_RE } from './mirror-rows'
import { assertDemoVenues } from './guard'
import { auxOnlyDeletes, auxOnlySteps, externalIdFor, offsetDate } from './plan'
import type { DemoCoupleStory, DemoDataset, DeleteOp, ReseedPlan, ReseedStep } from './types'

/** Split an array into chunks of at most `size`, so an `.in(...)` filter
 *  stays inside the URL length PostgREST will accept. */
function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------
// Injected writers
// ---------------------------------------------------------------------------

export interface LinkSignalCall {
  supabase: SupabaseClient
  venueId: string
  signal: NormalizedSignal
  bypassCache?: boolean
  judgeBudget?: unknown
  source?: string
}

export interface ReseedWriters {
  /** `linkSignal` from `@/lib/spine/cascade`. */
  linkSignal(args: LinkSignalCall): Promise<{ action: string; duplicate: boolean }>
  /** `mintWedding` from `@/lib/spine/cascade`. */
  mintWedding(input: {
    venueId: string
    signals: {
      email: string | null
      phone: string | null
      fullName: string | null
      partner1Name: string | null
      partner2Name: string | null
      weddingDate: string | null
      inquiryDate: string | null
      guestCount: number | null
    }
    supabase: SupabaseClient
    reason: string
  }): Promise<{ weddingId: string }>
  /** `mirrorCoupleFromWedding` — the canonical weddings-to-couples bridge. */
  mirrorCouple(input: {
    venueId: string
    weddingId: string
    supabase: SupabaseClient
  }): Promise<{ coupleId: string | null }>
  /** `recordEngagementEventsBatch` from `@/lib/services/heat-mapping`. */
  recordHeat(
    venueId: string,
    weddingId: string,
    events: Array<{ eventType: string; occurredAt: string; metadata?: Record<string, unknown> }>,
    direction: 'inbound' | 'outbound',
    occurredAt: string,
  ): Promise<unknown>
  /**
   * Only required in `mode: 'aux-only'`. The spine already exists on this
   * database from a prior full run; this resolves each story's wedding
   * and couple id from it instead of minting again.
   */
  resolveExistingSpine?(input: {
    supabase: SupabaseClient
    dataset: DemoDataset
  }): Promise<ExistingSpineIds>
}

export interface ExistingSpineIds {
  weddingIdByStory: Record<string, string>
  coupleIdByStory: Record<string, string>
  /** Story keys the lookup could not resolve — no touchpoint with the
   *  expected external_id, or a touchpoint with no couple attached. */
  missing: string[]
}

/**
 * Resolve wedding/couple ids for a dataset whose spine was already
 * written by a prior full reseed, without re-minting anything.
 *
 * Every signal `linkSignal` writes carries a deterministic
 * `demo-reseed:<story.key>:<index>` external_id (see `plan.ts`'s
 * `externalIdFor`), so a story's FIRST signal (index 0) is a stable
 * handle back to the touchpoint it produced, and from there to the
 * couple it anchored to and that couple's `source_wedding_id`. Two
 * round trips total, chunked, rather than one query per story.
 */
export async function resolveExistingSpineIds(
  supabase: SupabaseClient,
  dataset: DemoDataset,
): Promise<ExistingSpineIds> {
  const weddingIdByStory: Record<string, string> = {}
  const coupleIdByStory: Record<string, string> = {}
  const missing: string[] = []

  const heroStory = dataset.stories.find((s) => s.hero) ?? null
  if (heroStory?.pinnedWeddingId) weddingIdByStory[heroStory.key] = heroStory.pinnedWeddingId

  const nonHero = dataset.stories.filter((s) => !s.hero)
  const externalIdToStory = new Map(nonHero.map((s) => [externalIdFor(s, 0), s]))

  const touchpointByExternalId = new Map<string, string | null>()
  for (const batch of chunkArray([...externalIdToStory.keys()], 150)) {
    const { data, error } = await supabase
      .from('touchpoints')
      .select('external_id, couple_id')
      .in('external_id', batch)
    if (error) continue
    for (const row of (data ?? []) as Array<{ external_id: string; couple_id: string | null }>) {
      touchpointByExternalId.set(row.external_id, row.couple_id)
    }
  }

  for (const [externalId, story] of externalIdToStory) {
    const coupleId = touchpointByExternalId.get(externalId)
    if (coupleId === undefined) {
      missing.push(story.key)
      continue
    }
    if (coupleId) coupleIdByStory[story.key] = coupleId
  }

  if (heroStory) {
    const { data } = await supabase
      .from('couples')
      .select('id')
      .eq('source_wedding_id', heroStory.pinnedWeddingId)
      .maybeSingle()
    const heroCoupleId = (data as { id?: string } | null)?.id
    if (heroCoupleId) coupleIdByStory[heroStory.key] = heroCoupleId
  }

  const coupleIds = [...new Set(Object.values(coupleIdByStory))]
  const sourceWeddingByCoupleId = new Map<string, string | null>()
  for (const batch of chunkArray(coupleIds, 150)) {
    const { data, error } = await supabase
      .from('couples')
      .select('id, source_wedding_id')
      .in('id', batch)
    if (error) continue
    for (const row of (data ?? []) as Array<{ id: string; source_wedding_id: string | null }>) {
      sourceWeddingByCoupleId.set(row.id, row.source_wedding_id)
    }
  }

  for (const story of nonHero) {
    const coupleId = coupleIdByStory[story.key]
    if (!coupleId) continue
    const weddingId = sourceWeddingByCoupleId.get(coupleId)
    if (weddingId) weddingIdByStory[story.key] = weddingId
    else if (!missing.includes(story.key)) missing.push(story.key)
  }

  return { weddingIdByStory, coupleIdByStory, missing }
}

export interface ApplyOptions {
  supabase: SupabaseClient
  plan: ReseedPlan
  dataset: DemoDataset
  writers: ReseedWriters
  /** False writes. True (the default) walks and reports only. */
  dryRun?: boolean
  log?: (line: string) => void
  /**
   * 'full' (default): the whole plan — delete and rebuild the spine, then
   * replay every step. 'aux-only': the spine already exists on this
   * database from a prior full run; delete and rewrite only the
   * aux-owned tables (`auxOnlyDeletes` / `auxOnlySteps` from `plan.ts`),
   * resolving each story's wedding/couple id from the existing spine via
   * `writers.resolveExistingSpine` instead of minting again.
   */
  mode?: 'full' | 'aux-only'
}

export interface ApplyResult {
  dryRun: boolean
  venuesChecked: number
  deletes: Array<{ table: string; performed: boolean; error: string | null }>
  minted: number
  mirrored: number
  signalsLinked: number
  signalsDuplicate: number
  heatEventsWritten: number
  toursWritten: number
  lostDealsWritten: number
  weddingsUpdated: number
  /** Mirror rows written, by table. */
  auxRowsByTable: Record<string, number>
  /** storyKey to the wedding id the run used. */
  weddingIdByStory: Record<string, string>
  /** storyKey to the couples id the mirror made. Empty on a dry run. */
  coupleIdByStory: Record<string, string>
  errors: string[]
}

/**
 * Swap `<wedding:key>` and `<couple:key>` for the ids the run minted.
 *
 * A plan is built without a database, so an aux row cannot carry a real
 * foreign key. Only whole-string values are substituted: a placeholder
 * buried inside a sentence would be a bug in the generator, and quietly
 * patching it up would hide that.
 */
export function substituteRefs(
  row: Record<string, unknown>,
  resolveWedding: (key: string) => string | null,
  resolveCouple: (key: string) => string | null,
): { row: Record<string, unknown>; unresolved: string[] } {
  const out: Record<string, unknown> = {}
  const unresolved: string[] = []
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== 'string') {
      out[k] = v
      continue
    }
    const w = WEDDING_REF_RE.exec(v)
    if (w) {
      const id = resolveWedding(w[1])
      if (id === null) unresolved.push(v)
      out[k] = id
      continue
    }
    const c = COUPLE_REF_RE.exec(v)
    if (c) {
      const id = resolveCouple(c[1])
      if (id === null) unresolved.push(v)
      out[k] = id
      continue
    }
    out[k] = v
  }
  return { row: out, unresolved }
}

// ---------------------------------------------------------------------------
// Delete phase
// ---------------------------------------------------------------------------

/**
 * Execute one delete op. Split into two statements for `people` because
 * PostgREST's `not.in` excludes NULLs the way SQL does, which would leave
 * the venue's unattached people rows behind.
 */
export async function runDelete(
  supabase: SupabaseClient,
  op: DeleteOp,
): Promise<{ error: string | null }> {
  const errors: string[] = []

  const collect = (err: { message: string } | null): void => {
    if (err) errors.push(err.message)
  }

  if (op.keepWeddingIds && op.keepWeddingIds.length > 0) {
    const keep = `(${op.keepWeddingIds.join(',')})`
    const a = await supabase
      .from(op.table)
      .delete()
      .in('venue_id', op.venueIds)
      .is('wedding_id', null)
    collect(a.error)
    const b = await supabase
      .from(op.table)
      .delete()
      .in('venue_id', op.venueIds)
      .not('wedding_id', 'in', keep)
    collect(b.error)
  } else if (op.keepIds && op.keepIds.length > 0) {
    const keep = `(${op.keepIds.join(',')})`
    const r = await supabase
      .from(op.table)
      .delete()
      .in('venue_id', op.venueIds)
      .not('id', 'in', keep)
    collect(r.error)
  } else {
    const r = await supabase.from(op.table).delete().in('venue_id', op.venueIds)
    collect(r.error)
  }

  return { error: errors.length > 0 ? errors.join('; ') : null }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

const PLACEHOLDER = /^<minted:(.+)>$/

function storyIndex(dataset: DemoDataset): Map<string, DemoCoupleStory> {
  return new Map(dataset.stories.map((s) => [s.key, s]))
}

export async function applyReseed(options: ApplyOptions): Promise<ApplyResult> {
  const { supabase, plan, dataset, writers } = options
  const dryRun = options.dryRun ?? true
  const log = options.log ?? (() => {})
  const mode = options.mode ?? 'full'

  const stories = storyIndex(dataset)
  const result: ApplyResult = {
    dryRun,
    venuesChecked: 0,
    deletes: [],
    minted: 0,
    mirrored: 0,
    signalsLinked: 0,
    signalsDuplicate: 0,
    heatEventsWritten: 0,
    toursWritten: 0,
    lostDealsWritten: 0,
    weddingsUpdated: 0,
    auxRowsByTable: {},
    weddingIdByStory: {},
    coupleIdByStory: {},
    errors: [],
  }

  // The guard runs in dry-run too. A dry run that would have been refused
  // should say so, not print a tidy plan the operator then trusts.
  const venues = await assertDemoVenues(supabase, plan.venueIds)
  result.venuesChecked = venues.length
  for (const v of venues) {
    log(`  venue ok: ${v.id} ${v.name ?? ''} (is_demo=${String(v.is_demo)})`)
  }

  const deletes = mode === 'aux-only' ? auxOnlyDeletes(plan) : plan.deletes
  const steps = mode === 'aux-only' ? auxOnlySteps(plan) : plan.steps

  for (const op of deletes) {
    if (dryRun) {
      result.deletes.push({ table: op.table, performed: false, error: null })
      log(
        `  would delete ${op.table} where venue_id in (4 demo venues)` +
          (op.keepIds ? ` except id ${op.keepIds.join(', ')}` : '') +
          (op.keepWeddingIds ? ` except wedding_id ${op.keepWeddingIds.join(', ')}` : '') +
          ` — ${op.why}`,
      )
      continue
    }
    const { error } = await runDelete(supabase, op)
    if (error) result.errors.push(`delete ${op.table}: ${error}`)
    result.deletes.push({ table: op.table, performed: true, error })
    log(`  deleted ${op.table}${error ? ` (error: ${error})` : ''}`)
  }

  // Pre-seed the hero so its steps resolve before any mint runs.
  for (const story of dataset.stories) {
    if (story.pinnedWeddingId) result.weddingIdByStory[story.key] = story.pinnedWeddingId
  }

  if (mode === 'aux-only' && !dryRun) {
    if (!writers.resolveExistingSpine) {
      result.errors.push(
        'aux-only apply requires writers.resolveExistingSpine, and none was supplied',
      )
    } else {
      const resolved = await writers.resolveExistingSpine({ supabase, dataset })
      Object.assign(result.weddingIdByStory, resolved.weddingIdByStory)
      Object.assign(result.coupleIdByStory, resolved.coupleIdByStory)
      for (const key of resolved.missing) {
        result.errors.push(
          `aux-only: could not resolve an existing wedding/couple id for story ${key} ` +
            `— is the spine actually seeded on this database?`,
        )
      }
    }
  }

  const resolveWeddingId = (storyKey: string): string | null =>
    result.weddingIdByStory[storyKey] ?? null
  const resolveCoupleId = (storyKey: string): string | null =>
    result.coupleIdByStory[storyKey] ?? null

  for (const step of steps) {
    const story = stories.get(step.storyKey)
    if (!story) {
      result.errors.push(`step for unknown story ${step.storyKey}`)
      continue
    }

    try {
      await runStep(step, story, {
        supabase,
        writers,
        dryRun,
        result,
        resolveWeddingId,
        resolveCoupleId,
        today: plan.today,
      })
    } catch (err) {
      result.errors.push(
        `${step.kind} ${step.storyKey}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return result
}

interface StepContext {
  supabase: SupabaseClient
  writers: ReseedWriters
  dryRun: boolean
  result: ApplyResult
  resolveWeddingId: (storyKey: string) => string | null
  resolveCoupleId: (storyKey: string) => string | null
  today: string
}

/** PostgREST takes a batch happily; a 500-row array in one request does
 *  not. 200 keeps every insert well inside the payload limit. */
const AUX_CHUNK = 200

async function runStep(
  step: ReseedStep,
  story: DemoCoupleStory,
  ctx: StepContext,
): Promise<void> {
  const { supabase, writers, dryRun, result } = ctx

  switch (step.kind) {
    case 'mint_wedding': {
      result.minted++
      if (dryRun) {
        result.weddingIdByStory[story.key] = `<minted:${story.key}>`
        return
      }
      const minted = await writers.mintWedding({
        venueId: story.venueId,
        signals: {
          email: story.primaryEmail,
          phone: story.primaryPhone,
          fullName: story.primaryName,
          partner1Name: story.primaryName,
          partner2Name: story.partnerName,
          weddingDate:
            story.weddingDateOffsetDays === null
              ? null
              : offsetDate(ctx.today, story.weddingDateOffsetDays),
          inquiryDate: step.occurredAt,
          guestCount: story.guestCount,
        },
        supabase,
        reason: 'demo-reseed',
      })
      result.weddingIdByStory[story.key] = minted.weddingId
      return
    }

    case 'hero_contact_sync': {
      if (dryRun) return
      // An UPDATE, not a creation — outside the cascade's creation
      // boundary. It replaces the seed's gmail-looking address on the
      // preserved hero people rows with the reserved-domain one the rest
      // of the story uses, so the spine and the portal agree.
      const weddingId = ctx.resolveWeddingId(story.key)
      if (!weddingId) return
      const p1 = await supabase
        .from('people')
        .update({ email: story.primaryEmail, phone: story.primaryPhone })
        .eq('wedding_id', weddingId)
        .eq('role', 'partner1')
      if (p1.error) result.errors.push(`hero partner1 sync: ${p1.error.message}`)
      if (story.partnerEmail) {
        const p2 = await supabase
          .from('people')
          .update({ email: story.partnerEmail })
          .eq('wedding_id', weddingId)
          .eq('role', 'partner2')
        if (p2.error) result.errors.push(`hero partner2 sync: ${p2.error.message}`)
      }
      return
    }

    case 'mirror_couple': {
      result.mirrored++
      if (dryRun) return
      const weddingId = ctx.resolveWeddingId(story.key)
      if (!weddingId) {
        result.errors.push(`mirror_couple: no wedding id for ${story.key}`)
        return
      }
      const mirrored = await writers.mirrorCouple({
        venueId: story.venueId,
        weddingId,
        supabase,
      })
      if (mirrored.coupleId) result.coupleIdByStory[story.key] = mirrored.coupleId
      return
    }

    case 'aux_rows': {
      const table = step.table ?? ''
      const rows = step.rows ?? []
      if (AUX_FORBIDDEN_TABLES.includes(table)) {
        // Writer discipline, enforced rather than trusted. `couples`,
        // `touchpoints`, `weddings`, `people` and the progression log
        // have exactly one writer each and it is not this file.
        result.errors.push(
          `aux_rows: refusing to write ${table} — that table has one canonical writer ` +
            `(mintWedding / linkSignal), and it is not the mirror-row path.`,
        )
        return
      }
      result.auxRowsByTable[table] = (result.auxRowsByTable[table] ?? 0) + rows.length
      if (dryRun) return

      const resolved: Array<Record<string, unknown>> = []
      for (const raw of rows) {
        const { row, unresolved } = substituteRefs(raw, ctx.resolveWeddingId, ctx.resolveCoupleId)
        if (unresolved.length > 0) {
          result.errors.push(`aux_rows ${table}: unresolved ${unresolved.join(', ')}`)
          continue
        }
        resolved.push(row)
      }

      for (let i = 0; i < resolved.length; i += AUX_CHUNK) {
        const batch = resolved.slice(i, i + AUX_CHUNK)
        // Every aux row carries a deterministic id (uuidFrom(rng)), so an
        // aux-only rerun over an already-seeded database must upsert, not
        // insert: the first production rerun (2026-09-15) hit
        // table_map_layouts_pkey duplicates for exactly this reason.
        const idempotent = batch.every((r) => typeof (r as { id?: unknown }).id === 'string')
        const { error } = idempotent
          ? await supabase.from(table).upsert(batch, { onConflict: 'id' })
          : await supabase.from(table).insert(batch)
        if (error) {
          result.errors.push(`aux_rows ${table} (${story.key}): ${error.message}`)
          return
        }
      }
      return
    }

    case 'link_signal': {
      if (!step.signal) return
      result.signalsLinked++
      if (dryRun) return
      const weddingId = ctx.resolveWeddingId(story.key)
      if (!weddingId) {
        result.errors.push(`link_signal: no wedding id for ${story.key}`)
        return
      }
      const signal = withWeddingId(step.signal, weddingId)
      const linked = await writers.linkSignal({
        supabase,
        venueId: story.venueId,
        signal,
        bypassCache: true,
        source: 'demo-reseed',
      })
      if (linked.duplicate) {
        result.signalsLinked--
        result.signalsDuplicate++
      }
      return
    }

    case 'heat_events': {
      const events = step.heatEvents ?? []
      result.heatEventsWritten += events.length
      if (dryRun) return
      const weddingId = ctx.resolveWeddingId(story.key)
      if (!weddingId) return
      await writers.recordHeat(
        story.venueId,
        weddingId,
        events.map((eventType) => ({
          eventType,
          occurredAt: step.occurredAt,
          metadata: { source: 'demo-reseed', story: story.key },
        })),
        step.heatDirection ?? 'inbound',
        step.occurredAt,
      )
      return
    }

    case 'tour_row': {
      result.toursWritten++
      if (dryRun) return
      const weddingId = ctx.resolveWeddingId(story.key)
      if (!weddingId) return
      const { error } = await supabase
        .from('tours')
        .insert({ ...(step.row ?? {}), wedding_id: weddingId })
      if (error) result.errors.push(`tours insert ${story.key}: ${error.message}`)
      return
    }

    case 'lost_deal_row': {
      result.lostDealsWritten++
      if (dryRun) return
      const weddingId = ctx.resolveWeddingId(story.key)
      if (!weddingId) return
      const { error } = await supabase
        .from('lost_deals')
        .insert({ ...(step.row ?? {}), wedding_id: weddingId })
      if (error) result.errors.push(`lost_deals insert ${story.key}: ${error.message}`)
      return
    }

    case 'wedding_state': {
      result.weddingsUpdated++
      if (dryRun) return
      const weddingId = ctx.resolveWeddingId(story.key)
      if (!weddingId) return
      const { error } = await supabase
        .from('weddings')
        .update(step.weddingPatch ?? {})
        .eq('id', weddingId)
      if (error) result.errors.push(`weddings update ${story.key}: ${error.message}`)
      return
    }
  }
}

/** Swap the plan's `<minted:key>` placeholder for the id the run got
 *  back from `mintWedding`. */
export function withWeddingId(
  signal: NormalizedSignal,
  weddingId: string,
): NormalizedSignal {
  const current = signal.legacy_wedding_id ?? null
  if (current !== null && !PLACEHOLDER.test(current)) return signal
  return { ...signal, legacy_wedding_id: weddingId }
}
