/**
 * OMI Dev Kit 2 wearable audio-capture adapter (T2-E Phase 2).
 *
 * OMI's wire shape (per Omi developer docs / Ground app integration):
 *
 *   {
 *     session_id: string,
 *     segments: [
 *       { text: string, is_user?: boolean, speaker?: string,
 *         start?: number, end?: number }
 *     ]
 *   }
 *
 * - is_user=true  → the wearable's owner spoke (the venue coordinator).
 * - is_user=false → someone else spoke (the visitor / couple).
 * - speaker is sometimes "speaker_0" / "speaker_1", sometimes a
 *   plaintext label.
 * - start / end are seconds (float). We round to ms for storage.
 *
 * No PII redaction at the adapter — that's the storage layer's job
 * (transcript_segments rows are tier-1 content, surfaced only behind
 * coordinator auth + RLS).
 */

import type { AudioCaptureAdapter, NormalizedSegment } from '../types'

interface OmiRawSegment {
  text?: unknown
  is_user?: unknown
  speaker?: unknown
  start?: unknown
  end?: unknown
  [k: string]: unknown
}

interface OmiPayload {
  session_id?: unknown
  segments?: unknown
  [k: string]: unknown
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function normaliseOmiSpeaker(seg: OmiRawSegment): 'host' | 'visitor' | 'unknown' {
  // is_user is the authoritative flag per OMI's contract: true =
  // wearable owner. The wearable is bound to the coordinator per
  // venue, so is_user=true → host.
  const isUser = asBool(seg.is_user)
  if (isUser === true) return 'host'
  if (isUser === false) return 'visitor'
  // Fall back to speaker label heuristic. OMI sometimes emits 'speaker_0'
  // (coordinator) and 'speaker_1' (visitor) but the order is not
  // guaranteed across sessions, so we don't pin those.
  return 'unknown'
}

export const omiAdapter: AudioCaptureAdapter = {
  providerKey: 'omi',

  extractSessionId(rawPayload: unknown): string | null {
    const p = rawPayload as OmiPayload | null
    return p ? asString(p.session_id) : null
  },

  parseSegments(rawPayload: unknown): NormalizedSegment[] {
    const p = rawPayload as OmiPayload | null
    if (!p || !Array.isArray(p.segments)) return []

    const out: NormalizedSegment[] = []
    for (const raw of p.segments as OmiRawSegment[]) {
      const text = asString(raw.text)?.trim()
      if (!text) continue

      const startSec = asNumber(raw.start)
      const endSec = asNumber(raw.end)
      const startMs = startSec !== null ? Math.round(startSec * 1000) : null
      const endMs = endSec !== null ? Math.round(endSec * 1000) : null

      out.push({
        text,
        speaker: asString(raw.speaker),
        speakerNormalised: normaliseOmiSpeaker(raw),
        isUser: asBool(raw.is_user),
        startMs,
        endMs,
        // Capture forensic raw shape but cap. Providers occasionally
        // return verbose metadata (confidence per word, alternates);
        // we don't want a 200-segment payload to balloon row size.
        metadata: {
          // Whitelist only. Add fields here if a future debug task
          // needs them.
          ...(raw.speaker !== undefined ? { speaker_raw: raw.speaker } : {}),
          ...(raw.is_user !== undefined ? { is_user_raw: raw.is_user } : {}),
        },
      })
    }
    return out
  },
}
