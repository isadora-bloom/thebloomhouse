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
import { assertDemoVenues } from './guard'
import { offsetDate } from './plan'
import type { DemoCoupleStory, DemoDataset, DeleteOp, ReseedPlan, ReseedStep } from './types'

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
}

export interface ApplyOptions {
  supabase: SupabaseClient
  plan: ReseedPlan
  dataset: DemoDataset
  writers: ReseedWriters
  /** False writes. True (the default) walks and reports only. */
  dryRun?: boolean
  log?: (line: string) => void
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
  /** storyKey to the wedding id the run used. */
  weddingIdByStory: Record<string, string>
  errors: string[]
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
    weddingIdByStory: {},
    errors: [],
  }

  // The guard runs in dry-run too. A dry run that would have been refused
  // should say so, not print a tidy plan the operator then trusts.
  const venues = await assertDemoVenues(supabase, plan.venueIds)
  result.venuesChecked = venues.length
  for (const v of venues) {
    log(`  venue ok: ${v.id} ${v.name ?? ''} (is_demo=${String(v.is_demo)})`)
  }

  for (const op of plan.deletes) {
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

  const resolveWeddingId = (storyKey: string): string | null =>
    result.weddingIdByStory[storyKey] ?? null

  for (const step of plan.steps) {
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
  today: string
}

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
      await writers.mirrorCouple({ venueId: story.venueId, weddingId, supabase })
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
