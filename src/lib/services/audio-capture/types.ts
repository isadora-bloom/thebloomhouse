/**
 * Audio-capture provider abstraction (T2-E Phase 2 / ARCH-5.4).
 *
 * Pre-T2-E the OMI webhook hard-coded payload parsing + persistence
 * in one ~290-line route. Adding a second provider (iPhone upload,
 * Otter, AssemblyAI, Deepgram) required forking that route. This
 * module decouples the two:
 *   - Adapter      — provider-specific. Knows the wire shape.
 *                    Returns NormalizedSegment[].
 *   - Orchestrator — provider-agnostic. Takes normalized segments
 *                    and persists to transcript_segments + the
 *                    rolled-up tours.transcript text aggregate.
 *
 * Adding a new provider = implementing AudioCaptureAdapter +
 * registering it on the route. Orchestrator + downstream services
 * (extract / brief / voice-learning) don't change.
 */

/**
 * Provider-agnostic segment shape. Every adapter normalises its
 * provider's wire format into this. The orchestrator never sees
 * provider-specific fields.
 */
export interface NormalizedSegment {
  /** Free text — required, non-empty after trim. */
  text: string
  /** Raw provider speaker label, if any (e.g. 'speaker_0', 'host',
   *  'ai'). Stored verbatim for forensic record. */
  speaker: string | null
  /** Adapter-mapped speaker role: host = venue/coordinator,
   *  visitor = couple/prospect, unknown = ambiguous or pre-classified. */
  speakerNormalised: 'host' | 'visitor' | 'unknown'
  /** OMI's is_user flag preserved as-is. Some providers don't emit
   *  it; null when absent. */
  isUser: boolean | null
  /** Timing offsets (milliseconds within the session). null when the
   *  provider doesn't emit timing. */
  startMs: number | null
  endMs: number | null
  /** Free-form provider-specific blob. Capped by adapter to keep row
   *  size sane. */
  metadata: Record<string, unknown>
}

/**
 * Audio-capture provider adapter. Implementors live under
 * src/lib/services/audio-capture/adapters/.
 */
export interface AudioCaptureAdapter {
  /** Stable provider key — written into transcript_segments.audio_provider
   *  and tours.audio_provider. Coordinator UI uses this for filtering. */
  providerKey: string

  /** Parse the raw provider wire payload into normalized segments.
   *  Pure function — no DB writes. Returns [] for empty / malformed
   *  payloads (caller acks with 200 to avoid the provider retrying). */
  parseSegments(rawPayload: unknown): NormalizedSegment[]

  /** Extract the session_id from the raw payload. The orchestrator
   *  uses this to group segments and bind to a tour / orphan. */
  extractSessionId(rawPayload: unknown): string | null
}
