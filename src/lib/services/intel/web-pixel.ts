/**
 * Bloom House — Wave 6E follow-up.
 *
 * Service helpers for the web pixel:
 *   - Ensure the venue has a pixel_ingest_key (lazy-generated on first
 *     read of the config page).
 *   - Rotate the key (returns the new value; caller swaps the snippet).
 *   - Link a cluster of web_visits to a candidate_identity once a form
 *     submission resolves the anonymous visitor.
 *
 * Reads + writes via service role. The /api/v1/visit endpoint also
 * uses service role; this module is for authenticated admin paths.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { randomUUID } from 'crypto'

export interface PixelConfig {
  venueId: string
  pixelIngestKey: string
  pixelInstalledAt: string | null
  recentVisitCount: number
  earliestVisitAt: string | null
}

export async function getOrCreatePixelConfig(
  venueId: string,
): Promise<PixelConfig> {
  const service = createServiceClient()
  const { data: existing } = await service
    .from('venue_config')
    .select('pixel_ingest_key, pixel_installed_at')
    .eq('venue_id', venueId)
    .maybeSingle()
  let pixelIngestKey = (existing?.pixel_ingest_key as string | null) ?? null
  if (!pixelIngestKey) {
    // Generate. The unique partial index on pixel_ingest_key catches
    // collisions; retry once if we lose the race.
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = randomUUID() + randomUUID().slice(0, 8)
      const update = await service
        .from('venue_config')
        .update({ pixel_ingest_key: candidate })
        .eq('venue_id', venueId)
        .is('pixel_ingest_key', null)
        .select('pixel_ingest_key')
        .maybeSingle()
      if (!update.error && update.data?.pixel_ingest_key) {
        pixelIngestKey = update.data.pixel_ingest_key as string
        break
      }
      // Race lost — re-read to see what the winner stored.
      const { data: r } = await service
        .from('venue_config')
        .select('pixel_ingest_key')
        .eq('venue_id', venueId)
        .maybeSingle()
      if (r?.pixel_ingest_key) {
        pixelIngestKey = r.pixel_ingest_key as string
        break
      }
    }
    if (!pixelIngestKey) {
      throw new Error('failed to allocate pixel_ingest_key')
    }
  }

  // Coverage signal for the TBH Report + config page.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { count: recentVisitCount } = await service
    .from('web_visits')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('occurred_at', since)

  const { data: earliest } = await service
    .from('web_visits')
    .select('occurred_at')
    .eq('venue_id', venueId)
    .order('occurred_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return {
    venueId,
    pixelIngestKey,
    pixelInstalledAt: (existing?.pixel_installed_at as string | null) ?? null,
    recentVisitCount: recentVisitCount ?? 0,
    earliestVisitAt: (earliest?.occurred_at as string | null) ?? null,
  }
}

export async function rotatePixelIngestKey(
  venueId: string,
): Promise<string> {
  const service = createServiceClient()
  const candidate = randomUUID() + randomUUID().slice(0, 8)
  const { error } = await service
    .from('venue_config')
    .update({ pixel_ingest_key: candidate })
    .eq('venue_id', venueId)
  if (error) throw new Error(`rotate pixel key failed: ${error.message}`)
  return candidate
}

/**
 * Tie all web_visits with (venue, anon_visitor_id) to the resolved
 * candidate identity. Called from the web-form adapter the moment a
 * form submission carrying bloom_visitor_id resolves to a new (or
 * matched) candidate.
 *
 * Returns the count of rows linked. Idempotent — a re-run on the same
 * cluster is a no-op past the first.
 */
export async function linkWebVisitsToCandidate(args: {
  venueId: string
  anonVisitorId: string
  candidateIdentityId: string
}): Promise<{ linked: number }> {
  if (!args.venueId || !args.anonVisitorId || !args.candidateIdentityId) {
    return { linked: 0 }
  }
  const service = createServiceClient()
  const { data, error } = await service
    .from('web_visits')
    .update({
      candidate_identity_id: args.candidateIdentityId,
      resolved_at: new Date().toISOString(),
    })
    .eq('venue_id', args.venueId)
    .eq('anon_visitor_id', args.anonVisitorId)
    .is('candidate_identity_id', null)
    .select('id')
  if (error) throw new Error(`link web visits failed: ${error.message}`)
  return { linked: data?.length ?? 0 }
}
