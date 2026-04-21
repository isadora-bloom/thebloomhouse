import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST /api/agent/wipe-pipeline-data?confirm=YES
//
// Deletes ALL pipeline data for the current venue:
//   intelligence_extractions, engagement_events, drafts,
//   interactions, people, weddings
// Preserves:
//   venue row, gmail_connections, user_profiles, AI config, prompt tuning,
//   website settings — anything that isn't tied to a specific lead.
//
// Scoped to venue_id. Requires confirm=YES to run (cheap accidental-click
// guard on top of the UI prompt).
//
// Use this when demo/seed data pollutes a fresh venue onboarding and you
// want a clean slate. After wiping, link Gmail and sync fresh.
// ---------------------------------------------------------------------------

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

  // 1. intelligence_extractions — scoped by venue_id directly.
  await runDelete('intelligence_extractions', async () => {
    const { count, error } = await supabase
      .from('intelligence_extractions')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })

  // 2. engagement_events — scoped by wedding_id.
  if (weddingIds.length > 0) {
    await runDelete('engagement_events', async () => {
      const { count, error } = await supabase
        .from('engagement_events')
        .delete({ count: 'exact' })
        .in('wedding_id', weddingIds)
      return { count, error }
    })
  } else counts['engagement_events'] = 0

  // 3. drafts — scoped by venue_id.
  await runDelete('drafts', async () => {
    const { count, error } = await supabase
      .from('drafts')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })

  // 4. interactions — scoped by venue_id.
  await runDelete('interactions', async () => {
    const { count, error } = await supabase
      .from('interactions')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })

  // 5. people — scoped by venue_id.
  await runDelete('people', async () => {
    const { count, error } = await supabase
      .from('people')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })

  // 6. weddings — last, since everything else referenced them.
  await runDelete('weddings', async () => {
    const { count, error } = await supabase
      .from('weddings')
      .delete({ count: 'exact' })
      .eq('venue_id', venueId)
    return { count, error }
  })

  // If any deletes errored (usually a table that doesn't exist yet in
  // older migrations), report them but don't block the rest.
  const ok = Object.keys(errors).length === 0
  return NextResponse.json({
    venueId,
    ok,
    deleted: counts,
    errors: ok ? undefined : errors,
  })
}
