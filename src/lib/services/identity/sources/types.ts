/**
 * Shared types for Phase B Tracer source adapters.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 ("Backwards Tracer
 * architecture") + §1 (six entity classes) + §2 (matcher).
 *
 * Each adapter walks a single channel's raw signals (interactions,
 * candidate_identities, tangential_signals, weddings.tour_date, ...)
 * and yields normalized `NormalizedSignal` rows. The Tracer treats
 * adapters as opaque async iterables — it doesn't know whether the
 * underlying source is a CSV import, an OAuth pull, or a legacy
 * table read. That separation makes the Tracer testable against
 * synthetic fixtures and keeps adapter-specific schema knowledge
 * confined to one file per channel.
 *
 * Why an iterator (vs a single array)
 * -----------------------------------
 * Touchpoint sweep over 5 years of Rixey production data is ~100K+
 * interactions per venue. Loading the array into memory before
 * processing risks blowing the heap and stalls progress events.
 * AsyncIterable + per-batch checkpoint events keep the Tracer
 * resumable and observable.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** The unified shape every adapter produces. Field names align with
 *  the new schema's `touchpoints` + `fragments` tables. */
export interface NormalizedSignal {
  /** Channel-specific stable id. Combined with venue_id + channel,
   *  forms the UNIQUE(venue_id, channel, external_id) rerun-safety
   *  primitive on both `touchpoints` and `fragments`. */
  external_id: string

  /** Channel taxonomy. Matches `touchpoints.channel` enum-shape:
   *  'gmail' | 'calendly' | 'honeybook' | 'knot' | 'weddingwire' |
   *  'instagram' | 'sms' | 'web' | 'review' | 'phone' | ... */
  channel: string

  /** Channel-specific verb. 'reply' | 'tour_booked' | 'tour_attended' |
   *  'knot_save' | 'knot_message' | 'ig_dm' | 'review_left' | ... */
  action_type: string

  /** When the signal happened in the real world (NOT when Bloom
   *  ingested it). Used by the matcher for cross-channel temporal
   *  scoring and by the decay sweep. */
  occurred_at: string

  /** Per-signal tier label. Drives §1 entity-class promotion. */
  signal_tier:
    | 'highest'
    | 'high'
    | 'medium_high'
    | 'medium'
    | 'low'
    | 'aggregate_only'

  /** Free-text hint for partial-identity signals ('Sarah R.',
   *  '@sarahross', null). Lands in fragments.identity_hint when
   *  the signal can't anchor to a couple. */
  identity_hint: string | null

  /** Structured identity fields the matcher reads. Most adapters
   *  populate a subset — Gmail signatures give email + phone +
   *  full name; Knot gives first + initial only; Instagram gives
   *  username + display name. Leaving fields null is fine — the
   *  matcher just doesn't score them. */
  primary_name?: string | null
  partner_name?: string | null
  primary_email?: string | null
  primary_phone?: string | null
  partner_email?: string | null
  partner_phone?: string | null
  wedding_date?: string | null
  session_ip?: string | null
  session_fingerprint?: string | null

  /** Raw payload for operator forensics + future reprocessing. Lands
   *  in touchpoints.raw_payload (GIN-indexed). */
  raw_payload: Record<string, unknown>

  /** Legacy join hint. When an adapter knows the signal is already
   *  anchored to a legacy weddings row (Gmail interactions with
   *  wedding_id set, Knot candidate_identities with
   *  resolved_wedding_id set), we pass the wedding_id so the Tracer
   *  can anchor the new touchpoint via couples.source_wedding_id
   *  → couples.id without re-running the matcher. */
  legacy_wedding_id?: string | null

  /** Author classification of the underlying message, when the channel
   *  has one (Gmail interactions carry interactions.author_class:
   *  'couple' | 'vendor' | 'platform_system' | 'operator' | 'sage' |
   *  'unknown'). The mint gate uses it to refuse minting a couple from
   *  a non-couple sender (a vendor blast, a platform notification).
   *  Null/undefined on channels without classification. */
  author_class?: string | null
}

export interface SourceAdapterArgs {
  supabase: SupabaseClient
  venueId: string
  /** Inclusive lower bound on occurred_at. Tracer passes null on
   *  full historical sweep, a recent timestamp on incremental
   *  refresh. */
  since?: string | null
  /** Page size for the underlying DB query. Default 500. */
  batchSize?: number
}

/** Each adapter exports a default instance of this. */
export interface SourceAdapter {
  /** Stable identifier for telemetry + tracer_run_events.detail. */
  name: string
  /** The channel value this adapter produces. */
  channel: string
  /** Async generator yielding signals. The Tracer drains it,
   *  checkpoints per batch, and writes a tracer_run_events row on
   *  each batch boundary. */
  walk(args: SourceAdapterArgs): AsyncIterable<NormalizedSignal>
}
