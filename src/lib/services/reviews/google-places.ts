/**
 * Google Places reviews fetcher (TIER 7e, 2026-05-14).
 *
 * The Google Places Details API is the only free public review surface
 * across the wedding industry. It returns up to 5 reviews per call
 * (most relevant by default; can also request newest). The API cost is
 * one "Place Details" call per venue per poll — Google's free tier
 * covers our scale comfortably.
 *
 * Other sources (Knot, WeddingWire, Zola, Yelp, Facebook) do not have
 * usable public APIs for review text. Those remain paste-only in the
 * /intel/reviews/paste UI.
 *
 * Polling cadence: weekly via the new `google_places_reviews_refresh`
 * cron job. Dedupe is by (venue_id, source='google', source_review_id).
 * Google's review-id stability is decent — same review text + reviewer
 * returns the same id in our experience.
 *
 * Env: GOOGLE_PLACES_API_KEY. The key needs Places API (New) enabled.
 */

import { createServiceClient } from '@/lib/supabase/service'

const PLACES_ENDPOINT = 'https://maps.googleapis.com/maps/api/place/details/json'

interface GoogleReview {
  author_name: string
  rating: number
  text: string
  time: number // Unix seconds
  language?: string
}

interface PlaceDetailsResponse {
  result?: {
    reviews?: GoogleReview[]
  }
  status: string
  error_message?: string
}

export interface GooglePlacesPollResult {
  venue_id: string
  ok: boolean
  reviews_fetched: number
  reviews_inserted: number
  error?: string
}

export async function pollGooglePlacesForVenue(
  venueId: string,
): Promise<GooglePlacesPollResult> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (!apiKey) {
    return {
      venue_id: venueId,
      ok: false,
      reviews_fetched: 0,
      reviews_inserted: 0,
      error: 'GOOGLE_PLACES_API_KEY not configured',
    }
  }

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

  const url = new URL(PLACES_ENDPOINT)
  url.searchParams.set('place_id', venue.google_place_id as string)
  url.searchParams.set('fields', 'reviews')
  url.searchParams.set('reviews_sort', 'newest')
  url.searchParams.set('key', apiKey)

  let json: PlaceDetailsResponse
  try {
    const res = await fetch(url.toString())
    json = (await res.json()) as PlaceDetailsResponse
  } catch (err) {
    return {
      venue_id: venueId,
      ok: false,
      reviews_fetched: 0,
      reviews_inserted: 0,
      error: err instanceof Error ? err.message : 'fetch failed',
    }
  }

  if (json.status !== 'OK') {
    return {
      venue_id: venueId,
      ok: false,
      reviews_fetched: 0,
      reviews_inserted: 0,
      error: `${json.status}: ${json.error_message ?? 'no detail'}`,
    }
  }

  const fetched = json.result?.reviews ?? []
  if (fetched.length === 0) {
    return { venue_id: venueId, ok: true, reviews_fetched: 0, reviews_inserted: 0 }
  }

  // Dedupe by (venue_id, source='google', source_review_id).
  // Google doesn't give a stable id; we derive one from author+time which
  // is stable enough for the same review across polls (Google's own
  // review-detail page keys on the same).
  const rows = fetched.map((r) => ({
    venue_id: venueId,
    source: 'google' as const,
    source_review_id: `google-${r.time}-${r.author_name.replace(/\s+/g, '_').toLowerCase()}`,
    reviewer_name: r.author_name,
    rating: r.rating,
    body: r.text,
    review_date: new Date(r.time * 1000).toISOString().slice(0, 10),
    title: null as string | null,
  }))

  // Check which source_review_ids already exist for this venue.
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
