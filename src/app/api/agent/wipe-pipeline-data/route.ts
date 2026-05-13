import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST /api/agent/wipe-pipeline-data?confirm=YES
//
// Deletes ALL pipeline data for the current venue. Preserves the venue
// row, gmail_connections, user_profiles, AI config, prompt tuning, and
// website settings — anything that isn't tied to a specific lead.
//
// Scoped to venue_id. Requires confirm=YES (cheap accidental-click guard
// on top of the UI prompt).
//
// Use this when demo/seed data pollutes a fresh venue onboarding and you
// want a clean slate. After wiping, link Gmail and sync fresh.
//
// 2026-05-13 refactor
// -------------------
// Used to hand-list 6 tables (intelligence_extractions, engagement_events,
// drafts, interactions, people, weddings) and relied on FK CASCADE for
// everything else. Same hand-list-drift bug class that
// `mergeWeddings` had — any new migration adding a `wedding_id`-keyed
// table without CASCADE would silently leak rows.
//
// Step 8 / G7 added `public._list_wedding_fk_columns()` (mig 334), which
// enumerates every FK column targeting weddings.id from pg_constraint.
// We now use that RPC: pull the full list, DELETE WHERE wedding_id IN
// (...) for each entry, then drop people, then weddings. Schema additions
// are picked up automatically on the next call.
//
// See [[bloom-repair-endpoint-classification]] §6 wipe-pipeline-data
// for the audit history.
// ---------------------------------------------------------------------------

interface FkRow {
  table_name: string
  column_name: string
}

export async function POST(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const url = new URL(req.url)
  if (url.searchParams.get('confirm') !== 'YES') {
    return NextResponse.json(
      { error: 'Destructive operation. Pass ?confirm=YES to proceed.' },
      { status: 400 }
    )
  }

  const supabase = createServiceClient()

  // Gather wedding IDs in scope so we can clean child tables that FK to
  // weddings but aren't directly venue-scoped in their schema.
  const { data: weddingRows } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
  const weddingIds = (weddingRows ?? []).map((w) => w.id as string)

  const counts: Record<string, number> = {}
  const errors: Record<string, string> = {}

  const runDelete = async (
    label: string,
    fn: () => Promise<{ count: number | null; error: { message: string } | null }>
  ) => {
    const { count, error } = await fn()
    if (error) errors[label] = error.message
    counts[label] = count ?? 0
  }

  // -------------------------------------------------------------------
  // Step 1 — venue-scoped tables. These have BOTH a venue_id column and
  // (often) a wedding_id column. We wipe by venue_id first to catch
  // orphan rows (wedding_id IS NULL) that wouldn't be hit by the
  // wedding_id IN (...) sweep below. The dynamic loop in Step 2 will
  // also touch any of these that appear in pg_constraint, but DELETE is
  // idempotent — a no-op the second time.
  // -------------------------------------------------------------------
  await runDelete('intelligence_extractions', async () => {
    const { count, error } = await supabase
      .from('intelligence_extractions')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })
  await runDelete('drafts', async () => {
    const { count, error } = await supabase
      .from('drafts')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })
  await runDelete('interactions', async () => {
    const { count, error } = await supabase
      .from('interactions')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })

  // -------------------------------------------------------------------
  // Step 2 — every wedding_id-keyed child table, sourced dynamically
  // from pg_constraint via the Step 8 RPC. If the RPC isn't available
  // (mig 334 not applied), fall back to the explicit handful of tables
  // we know existed historically — same as the legacy behaviour.
  // -------------------------------------------------------------------
  let fkRows: FkRow[] | null = null
  {
    const { data, error } = await supabase.rpc('_list_wedding_fk_columns')
    if (error) {
      errors['_list_wedding_fk_columns'] = error.message
    } else if (Array.isArray(data)) {
      fkRows = data as FkRow[]
    }
  }

  if (weddingIds.length > 0) {
    if (fkRows) {
      // attribution_events / wedding_touchpoints / candidate_identities
      // all have wedding_id FK ON DELETE CASCADE (mig 105). The final
      // weddings DELETE in step 4 wipes them automatically — explicitly
      // wiping here would be redundant.
      //
      // Cross-venue side-effect: attribution_events.referrer_wedding_id
      // (mig 279) is ON DELETE SET NULL, so wiping venue A's weddings
      // also NULLs the referrer pointer on venue B's attribution rows
      // that referenced them. Legitimate consequence of a venue wipe.
      const CASCADE_HANDLED = new Set([
        'attribution_events',
        'wedding_touchpoints',
        'candidate_identities',
      ])

      // Tables we handle separately (people, weddings) plus tables that
      // CASCADE auto-clean via the final weddings DELETE.
      const SKIP_TABLES = new Set([...CASCADE_HANDLED, 'people', 'weddings'])

      // Use whatever column name the FK uses (defaults to wedding_id in
      // practice, but we don't hardcode it — future schema additions are
      // picked up automatically).
      for (const { table_name, column_name } of fkRows) {
        if (SKIP_TABLES.has(table_name)) continue
        // eslint-disable-next-line no-await-in-loop -- order matters; one table at a time
        await runDelete(`${table_name}.${column_name}`, async () => {
          const { count, error } = await supabase
            .from(table_name)
            .delete({ count: 'exact' })
            .in(column_name, weddingIds)
          return { count, error }
        })
      }
    } else {
      // Fallback path when the RPC isn't available (mig 334 not applied).
      // Step 1 already handled drafts + interactions venue-wide; this
      // catches engagement_events, which has wedding_id but no venue_id
      // and would otherwise leak.
      await runDelete('engagement_events', async () => {
        const { count, error } = await supabase
          .from('engagement_events')
          .delete({ count: 'exact' })
          .in('wedding_id', weddingIds)
        return { count, error }
      })
    }
  }

  // -------------------------------------------------------------------
  // Step 3 — people (venue-scoped). Has a wedding_id FK but also a
  // separate venue_id column, so we wipe by venue to catch detached
  // (wedding_id IS NULL) rows the dynamic step missed.
  // -------------------------------------------------------------------
  await runDelete('people', async () => {
    const { count, error } = await supabase
      .from('people')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })

  // -------------------------------------------------------------------
  // Step 4 — weddings (last, since everything else FKs to them).
  // -------------------------------------------------------------------
  await runDelete('weddings', async () => {
    const { count, error } = await supabase
      .from('weddings')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })

  const ok = Object.keys(errors).length === 0
  return NextResponse.json({
    venueId,
    ok,
    deleted: counts,
    cascade_mode: fkRows ? 'dynamic' : 'fallback',
    errors: ok ? undefined : errors,
  })
}
