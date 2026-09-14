/**
 * GET / POST /api/settings/benchmark-participation
 *
 * The venue's own switch for cross-venue benchmarks (migration 410,
 * doctrine INV-24.1-A: opt-in, default off). Reading it tells the settings
 * page where the switch is; writing it is the only way it moves. The
 * platform never flips it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { refuseDemo, getPlatformAuth } from '@/lib/api/auth-helpers'

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!auth.venueId) return NextResponse.json({ error: 'no_venue_in_scope' }, { status: 400 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_config')
    .select('benchmark_participation')
    .eq('venue_id', auth.venueId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    participating: (data as { benchmark_participation: boolean | null } | null)?.benchmark_participation === true,
  })
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // The demo identity is an anonymous visitor. It may look; it may not write.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal
  if (!auth.venueId) return NextResponse.json({ error: 'no_venue_in_scope' }, { status: 400 })

  let body: { participating?: unknown } = {}
  try {
    body = (await req.json()) as { participating?: unknown }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof body.participating !== 'boolean') {
    return NextResponse.json({ error: 'participating must be true or false' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_config')
    .update({ benchmark_participation: body.participating })
    .eq('venue_id', auth.venueId)
    .select('benchmark_participation')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'venue_config row not found' }, { status: 404 })

  return NextResponse.json({
    participating: (data as { benchmark_participation: boolean | null }).benchmark_participation === true,
  })
}
