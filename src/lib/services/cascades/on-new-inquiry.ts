/**
 * New-inquiry cascade.
 *
 * Fires the moment a fresh `weddings` row lands via the email pipeline.
 * Today this catches up to the cron daily-sweep level of resolution by
 * running the identity-discovery cascade for the venue synchronously
 * (fire-and-forget). Without this, anonymous storefront signals
 * (Knot CSV, Instagram screenshots, Pinterest scrapes that pre-date the
 * inquiry) wait up to 24h before binding to the new wedding.
 *
 * Contract: fire-and-forget. Wraps `runIdentityCascadeForVenue` so
 * callers in the email pipeline can drop the promise without handling
 * the cascade's internals.
 *
 * Idempotency is owned by the underlying cascade (backtrack / resolver
 * / first-touch all carry their own watermark logic).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { runIdentityCascadeForVenue } from '../identity/cascade-on-enrichment'
import { logEvent } from '@/lib/observability/logger'

export interface NewInquiryCascadeArgs {
  venueId: string
  /** weddingId is logged for observability; the cascade itself sweeps
   *  every active wedding in the venue. */
  weddingId: string
  supabase: SupabaseClient
  correlationId?: string | null
}

export interface NewInquiryCascadeResult {
  weddingsScanned: number
  autoLinked: number
  queued: number
  resolved: number
  errors: number
  latencyMs: number
}

export async function triggerNewInquiryCascade(
  args: NewInquiryCascadeArgs,
): Promise<NewInquiryCascadeResult> {
  const { venueId, weddingId, supabase, correlationId } = args
  const started = Date.now()
  const result: NewInquiryCascadeResult = {
    weddingsScanned: 0,
    autoLinked: 0,
    queued: 0,
    resolved: 0,
    errors: 0,
    latencyMs: 0,
  }

  try {
    const out = await runIdentityCascadeForVenue(
      venueId,
      supabase,
      'new_inquiry_sync',
    )
    result.weddingsScanned = out.weddingsScanned
    result.autoLinked = out.totalAutoLinked
    result.queued = out.totalQueued
    result.resolved = out.totalResolved
    result.errors = out.totalErrors
  } catch (err) {
    result.errors = 1
    console.warn(
      '[cascade/new-inquiry] underlying cascade threw:',
      err instanceof Error ? err.message : String(err),
    )
  }

  result.latencyMs = Date.now() - started

  logEvent({
    level: result.errors > 0 ? 'warn' : 'info',
    msg: 'cascade.new_inquiry',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'cascade.new_inquiry',
    outcome: result.errors > 0 ? 'fail' : 'ok',
    latency_ms: result.latencyMs,
    data: {
      wedding_id: weddingId,
      weddings_scanned: result.weddingsScanned,
      auto_linked: result.autoLinked,
      queued: result.queued,
      resolved: result.resolved,
      error_count: result.errors,
    },
  })

  return result
}
