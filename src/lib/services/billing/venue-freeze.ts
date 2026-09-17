/**
 * venue-freeze: the app's side of the trial freeze (migration 417).
 *
 * When a venue's trial ends with no Stripe subscription the account is
 * frozen. People can sign in and read everything; nothing is written for
 * that venue. The database enforces it with trg_venue_freeze on every
 * venue table, which is the guarantee. This file is for refusing EARLY,
 * before the expensive or irreversible part happens:
 *
 *   - a model call (src/lib/ai/client.ts), which costs money even if the
 *     write after it is refused
 *   - an outbound email (email/gmail.ts, email/transport.ts). A send
 *     whose "sent" marker is then refused by the trigger would go out
 *     again on the next tick, so the send itself has to stop
 *   - the polling loops, so a frozen venue isn't fetched from Gmail,
 *     Zoom or OpenPhone every few minutes only to fail on write
 *   - the middleware, so an API write gets a clear 402 instead of a
 *     database error halfway through a route
 *
 * The rule is NOT restated here. public.venue_is_frozen() in the database
 * is the one definition; this file asks it. A lookup failure answers "not
 * frozen" (fail open), because the trigger still refuses the write and a
 * DB hiccup must never block a paying venue.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { VENUE_FROZEN_CODE, VENUE_FROZEN_SQLSTATE } from './venue-freeze-constants'

export { VENUE_FROZEN_CODE, VENUE_FROZEN_SQLSTATE, VENUE_FROZEN_MESSAGE } from './venue-freeze-constants'

export class VenueFrozenError extends Error {
  readonly code = VENUE_FROZEN_CODE
  constructor(readonly venueId: string) {
    super(`${VENUE_FROZEN_CODE}: venue ${venueId} is frozen (trial ended, no subscription)`)
    this.name = 'VenueFrozenError'
  }
}

/** True for our own error and for the trigger's error coming back from Supabase. */
export function isVenueFrozenError(err: unknown): boolean {
  if (err instanceof VenueFrozenError) return true
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  return (
    e.code === VENUE_FROZEN_SQLSTATE ||
    e.code === VENUE_FROZEN_CODE ||
    (typeof e.message === 'string' && e.message.startsWith(`${VENUE_FROZEN_CODE}:`))
  )
}

// A short per-process cache. A pipeline run makes many model calls for
// one venue; one lookup per venue per minute is plenty. Subscribing
// unfreezes within a minute on every warm instance.
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { frozen: boolean; expiresAt: number }>()

/** Test hook. */
export function clearVenueFreezeCache(): void {
  cache.clear()
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export async function isVenueFrozen(
  venueId: string | null | undefined,
  supabase?: SupabaseClient,
): Promise<boolean> {
  // 'system' and other non-venue ids are platform work, never frozen.
  if (!venueId || !isUuid(venueId)) return false

  const hit = cache.get(venueId)
  if (hit && hit.expiresAt > Date.now()) return hit.frozen

  try {
    const client = supabase ?? createServiceClient()
    const { data, error } = await client.rpc('venue_is_frozen', { p_venue_id: venueId })
    if (error) {
      console.error('[venue-freeze] lookup failed:', error.message)
      return false
    }
    const frozen = data === true
    cache.set(venueId, { frozen, expiresAt: Date.now() + CACHE_TTL_MS })
    return frozen
  } catch (err) {
    console.error('[venue-freeze] lookup threw:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function assertVenueNotFrozen(
  venueId: string | null | undefined,
  supabase?: SupabaseClient,
): Promise<void> {
  if (venueId && (await isVenueFrozen(venueId, supabase))) {
    throw new VenueFrozenError(venueId)
  }
}

/**
 * Drops frozen venues from a list, for the loops that fan out over
 * venues. Order is kept. Checks run in parallel and share the cache.
 */
export async function withoutFrozenVenues(
  venueIds: Iterable<string>,
  supabase?: SupabaseClient,
): Promise<string[]> {
  const ids = Array.from(venueIds)
  const frozen = await Promise.all(ids.map((id) => isVenueFrozen(id, supabase)))
  return ids.filter((_, i) => !frozen[i])
}
