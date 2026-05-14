/**
 * Google Places reviews fetcher — Places API v1 (TIER 7+ 2026-05-14).
 *
 * Migrated from the legacy maps.googleapis.com/place/details endpoint to
 * places.googleapis.com/v1/places/{placeId}. The v1 API gives us a stable
 * resource name per review (places/{placeId}/reviews/{reviewId}) which we
 * use directly as source_review_id, instead of the legacy
 * `google-${time}-${author}` derivation that broke on reviewer renames.
 *
 * Returns up to 5 reviews per call. v1 has no explicit "newest" sort —
 * Google returns its picks for the venue. Dedupe by (venue_id, source,
 * source_review_id) catches reruns. For full historical backfill,
 * operators paste reviews via /intel/reviews/paste.
 *
 * Other sources (Knot, WeddingWire, Zola, Yelp, Facebook) do not have
 * usable public APIs for review text. Those remain paste-only.
 *
 * Polling cadence: weekly via the `google_places_reviews_refresh` cron
 * + operator-triggered `POST /api/intel/reviews/google-pull` for first-
 * run / on-demand.
 *
 * Env: GOOGLE_PLACES_API_KEY. The key needs Places API (New) enabled.
 */

import { createServiceClient } from '@/lib/supabase/service'

const PLACES_V1_ENDPOINT = 'https://places.googleapis.com/v1/places'

interface V1LocalizedText {
  text: string
  languageCode?: string
}

interface V1AuthorAttribution {
  displayName?: string
  uri?: string
  photoUri?: string
}

interface V1Review {
  name: string // "places/{placeId}/reviews/{reviewId}" — stable
  rating: number
  text?: V1LocalizedText
  originalText?: V1LocalizedText
  publishTime?: string // ISO 8601
  authorAttribution?: V1AuthorAttribution
}

interface V1PlaceResponse {
  id?: string
  displayName?: V1LocalizedText
  formattedAddress?: string
  reviews?: V1Review[]
}

interface V1ErrorBody {
  error?: { code?: number; message?: string; status?: string }
}

export interface GooglePlacesPollResult {
  venue_id: string
  ok: boolean
  reviews_fetched: number
  reviews_inserted: number
  error?: string
}

export interface GooglePlaceValidation {
  ok: boolean
  place_id?: string
  display_name?: string
  formatted_address?: string
  error?: string
}

async function fetchV1(
  placeId: string,
  fieldMask: string,
): Promise<{ data?: V1PlaceResponse; error?: string }> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (!apiKey) return { error: 'GOOGLE_PLACES_API_KEY not configured' }

  const url = `${PLACES_V1_ENDPOINT}/${encodeURIComponent(placeId)}`
  try {
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
    })
    if (!res.ok) {
      // v1 returns JSON {error:{code,message,status}}
      try {
        const body = (await res.json()) as V1ErrorBody
        return {
          error: `${body.error?.status ?? res.status}: ${body.error?.message ?? res.statusText}`,
        }
      } catch {
        return { error: `HTTP ${res.status} ${res.statusText}` }
      }
    }
    const data = (await res.json()) as V1PlaceResponse
    return { data }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'fetch failed' }
  }
}

/**
 * Validate a Google Place ID without writing anything. Returns the
 * venue's display name + formatted address. Powers the "Test" button on
 * /settings/venue-info so operators can confirm they've pasted the right
 * Place ID before the weekly cron starts polling against it.
 */
export async function validateGooglePlaceId(
  placeId: string,
): Promise<GooglePlaceValidation> {
  if (!placeId || placeId.trim().length === 0) {
    return { ok: false, error: 'place_id is empty' }
  }
  const { data, error } = await fetchV1(placeId.trim(), 'id,displayName,formattedAddress')
  if (error || !data) return { ok: false, error: error ?? 'no response' }
  return {
    ok: true,
    place_id: data.id ?? placeId,
    display_name: data.displayName?.text,
    formatted_address: data.formattedAddress,
  }
}

export async function pollGooglePlacesForVenue(
  venueId: string,
): Promise<GooglePlacesPollResult> {
  const supabase = createServiceClient()
  const { data: venue, error: vErr } = await supabase
    .from('venues')
    .select('google_place_id')
    .eq('id', venueId)
    .single()

  if (vErr || !venue?.google_place_id) {
    return {
      venue_id: venueId,
      ok: false,
      reviews_fetched: 0,
      reviews_inserted: 0,
      error: vErr?.message ?? 'venue has no google_place_id',
    }
  }

  const placeId = (venue.google_place_id as string).trim()
  const { data, error } = await fetchV1(placeId, 'id,reviews')
  if (error || !data) {
    return {
      venue_id: venueId,
      ok: false,
      reviews_fetched: 0,
      reviews_inserted: 0,
      error: error ?? 'no response',
    }
  }

  const fetched = data.reviews ?? []
  if (fetched.length === 0) {
    return { venue_id: venueId, ok: true, reviews_fetched: 0, reviews_inserted: 0 }
  }

  // Build dedupe candidates from v1's stable `name` field.
  const rows = fetched
    .filter((r) => r.name && r.rating && (r.text?.text || r.originalText?.text))
    .map((r) => {
      const body = (r.text?.text ?? r.originalText?.text ?? '').trim()
      const publish = r.publishTime ? new Date(r.publishTime) : new Date()
      return {
        venue_id: venueId,
        source: 'google' as const,
        source_review_id: r.name, // full resource name; stable forever
        reviewer_name: r.authorAttribution?.displayName ?? null,
        rating: Math.round(r.rating),
        body,
        review_date: publish.toISOString().slice(0, 10),
        title: null as string | null,
      }
    })

  if (rows.length === 0) {
    return { venue_id: venueId, ok: true, reviews_fetched: fetched.length, reviews_inserted: 0 }
  }

  // Dedupe by (venue_id, source='google', source_review_id).
  const ids = rows.map((r) => r.source_review_id)
  const { data: existing } = await supabase
    .from('reviews')
    .select('source_review_id')
    .eq('venue_id', venueId)
    .eq('source', 'google')
    .in('source_review_id', ids)

  type Existing = { source_review_id: string }
  const seen = new Set(((existing ?? []) as Existing[]).map((e) => e.source_review_id))
  const toInsert = rows.filter((r) => !seen.has(r.source_review_id))

  if (toInsert.length === 0) {
    return {
      venue_id: venueId,
      ok: true,
      reviews_fetched: fetched.length,
      reviews_inserted: 0,
    }
  }

  const { error: insertErr } = await supabase.from('reviews').insert(toInsert)
  if (insertErr) {
    return {
      venue_id: venueId,
      ok: false,
      reviews_fetched: fetched.length,
      reviews_inserted: 0,
      error: insertErr.message,
    }
  }

  return {
    venue_id: venueId,
    ok: true,
    reviews_fetched: fetched.length,
    reviews_inserted: toInsert.length,
  }
}

export async function pollGooglePlacesForAllVenues(): Promise<
  Record<string, GooglePlacesPollResult>
> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .not('google_place_id', 'is', null)

  if (!venues || venues.length === 0) {
    return {}
  }

  const results: Record<string, GooglePlacesPollResult> = {}
  for (const v of venues) {
    const id = (v as { id: string }).id
    try {
      results[id] = await pollGooglePlacesForVenue(id)
    } catch (err) {
      results[id] = {
        venue_id: id,
        ok: false,
        reviews_fetched: 0,
        reviews_inserted: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  return results
}
