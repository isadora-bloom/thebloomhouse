/**
 * Content Suggester — USP route.
 *
 * POST /api/admin/content-suggest/usps
 * Body: { venueId }
 *
 * Returns LLM-proposed USP suggestions extracted from the venue's
 * own marketing website. The operator reviews each suggestion in the
 * UI before any of them land in venue_usps — this route never writes.
 *
 * Anchor docs:
 *   - memory/bloom-constitution.md (operator authority — the LLM
 *     proposes, the operator decides)
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
import { extractUSPs } from '@/lib/services/content-suggester/extract-usps'

export const maxDuration = 60

interface PostBody {
  venueId?: string
}

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

  // Resolve the venue's website URL + display name. The canonical
  // home for the URL is venue_ai_config.signature_website (added in
  // migration 195 — the field the email-signature builder reads).
  const [{ data: aiCfg }, { data: cfg }] = await Promise.all([
    sb.from('venue_ai_config')
      .select('signature_website')
      .eq('venue_id', venueId)
      .maybeSingle(),
    sb.from('venue_config')
      .select('business_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
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

  // Fetch existing USPs so the LLM can exclude duplicates.
  const { data: existingRows } = await sb
    .from('venue_usps')
    .select('usp_text')
    .eq('venue_id', venueId)
  const existingUSPs = ((existingRows ?? []) as Array<{ usp_text: string | null }>)
    .map((r) => (r.usp_text ?? '').trim())
    .filter((s) => s.length > 0)

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

  const result = await extractUSPs({
    venueId,
    venueName,
    pageText: fetchResult.combinedText,
    currentUSPs: existingUSPs,
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
