/**
 * Content Suggester — Seasonal route.
 *
 * POST /api/admin/content-suggest/seasonal
 * Body: { venueId }
 *
 * Returns LLM-proposed seasonal imagery + phrases per season,
 * extracted from the venue's own marketing website. The operator
 * reviews each suggestion in the UI before any of it lands in
 * venue_seasonal_content. This route never writes.
 *
 * Anchor docs:
 *   - memory/bloom-constitution.md (operator authority)
 *   - memory/bloom-may9-llm-vs-template.md (LLM is the primitive)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  assertCanAccessVenue,
} from '@/lib/api/auth-helpers'
import {
  fetchVenueHomepage,
  ContentFetchError,
  normaliseVenueUrl,
} from '@/lib/services/content-suggester/fetch-page'
import { extractSeasonalContent } from '@/lib/services/content-suggester/extract-seasonal'
import type { ExistingSeasonalContent, Season } from '@/config/prompts/seasonal-extractor'

export const maxDuration = 60

interface PostBody {
  venueId?: string
}

const SEASONS: readonly Season[] = ['spring', 'summer', 'fall', 'winter']

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const venueId = typeof body.venueId === 'string' ? body.venueId : null
  if (!venueId) return badRequest('venueId required')

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return forbidden('demo cannot trigger content-suggester')
  }
  const access = await assertCanAccessVenue(auth, venueId)
  if (!access.ok) return forbidden(access.reason)

  const sb = createServiceClient()

  // Resolve the venue's website URL + display name.
  const [{ data: aiCfg }, { data: cfg }, { data: seasonalRows }] = await Promise.all([
    sb.from('venue_ai_config')
      .select('signature_website')
      .eq('venue_id', venueId)
      .maybeSingle(),
    sb.from('venue_config')
      .select('business_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
    sb.from('venue_seasonal_content')
      .select('season, imagery, phrases')
      .eq('venue_id', venueId),
  ])

  const rawUrl = (aiCfg as { signature_website?: string | null } | null)?.signature_website ?? null
  const websiteUrl = normaliseVenueUrl(rawUrl)
  if (!websiteUrl) {
    return NextResponse.json(
      {
        error:
          'Set your website URL first in /settings/venue-info so the suggester knows where to read your venue copy from.',
      },
      { status: 400 },
    )
  }

  const venueName = (cfg as { business_name?: string | null } | null)?.business_name ?? ''

  // Build the existing-content map for exclusion.
  const current: ExistingSeasonalContent = {
    spring: { imagery: null, phrases: [] },
    summer: { imagery: null, phrases: [] },
    fall: { imagery: null, phrases: [] },
    winter: { imagery: null, phrases: [] },
  }
  for (const r of (seasonalRows ?? []) as Array<{
    season: string
    imagery: string | null
    phrases: string[] | null
  }>) {
    const s = r.season as Season
    if (SEASONS.includes(s)) {
      current[s] = {
        imagery: r.imagery ?? null,
        phrases: r.phrases ?? [],
      }
    }
  }

  // Fetch the venue homepage (+ shallow subpages).
  let fetchResult
  try {
    fetchResult = await fetchVenueHomepage(websiteUrl)
  } catch (err) {
    if (err instanceof ContentFetchError) {
      return NextResponse.json(
        {
          error: `We couldn't read ${websiteUrl}: ${err.message}`,
          reason: err.reason,
        },
        { status: 400 },
      )
    }
    throw err
  }

  const result = await extractSeasonalContent({
    venueId,
    venueName,
    pageText: fetchResult.combinedText,
    current,
  })

  return NextResponse.json({
    ok: true,
    venueId,
    websiteUrl: fetchResult.homepage.finalUrl,
    subpagesFetched: fetchResult.subpages.length,
    suggestions: result.suggestions,
    reasoning: result.reasoning,
    skipped: result.skipped,
    skipReason: result.skipReason,
  })
}
