/**
 * Fetch + clean a Zoom meeting transcript.
 *
 * Zoom's `recording.transcript_completed` webhook carries one or more
 * `download_url`s pointing to VTT (WebVTT) files. The download requires
 * a Bearer token — either:
 *   (a) the short-lived `download_token` Zoom includes in the webhook
 *       payload (preferred, scoped to the specific recording), or
 *   (b) a long-lived OAuth access token from a Server-to-Server app
 *       installed in the venue's Zoom account (`ZOOM_OAUTH_TOKEN`).
 *
 * This helper supports both. The webhook payload's download_token wins
 * when present; ZOOM_OAUTH_TOKEN is a fallback for testing + replay.
 *
 * Env-var guard: ZOOM_OAUTH_TOKEN is OPTIONAL. The function only fails
 * the fetch when BOTH download_token and the env var are missing — the
 * caller is expected to handle that case (log + skip).
 *
 * The VTT-to-plaintext clean strips timestamps, cue identifiers, and
 * speaker tags so the resulting body fits the interactions.body
 * conventions (free-text, no markup). Speaker names are preserved as
 * "Speaker Name: text" prefixes for downstream attribution.
 */

export interface FetchTranscriptInput {
  /** The transcript download URL from the webhook payload. */
  transcriptUrl: string
  /** Per-recording download token Zoom embeds in the webhook payload. */
  downloadToken?: string | null
}

export interface FetchTranscriptResult {
  ok: boolean
  text: string | null
  /** Diagnostic. Set when ok=false. */
  reason?: string
}

/**
 * Fetch the transcript URL and return cleaned plain text.
 * Returns `{ ok: false, reason }` on missing creds or network errors.
 * Never throws.
 */
export async function fetchAndCleanZoomTranscript(
  input: FetchTranscriptInput,
): Promise<FetchTranscriptResult> {
  const { transcriptUrl, downloadToken } = input

  if (!transcriptUrl) {
    return { ok: false, text: null, reason: 'missing_transcript_url' }
  }

  const envToken = process.env.ZOOM_OAUTH_TOKEN ?? null
  const bearer = downloadToken || envToken
  if (!bearer) {
    return {
      ok: false,
      text: null,
      reason: 'no_download_token_or_oauth',
    }
  }

  try {
    const res = await fetch(transcriptUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'text/vtt, text/plain, */*',
      },
    })
    if (!res.ok) {
      return {
        ok: false,
        text: null,
        reason: `http_${res.status}`,
      }
    }
    const raw = await res.text()
    const text = cleanVtt(raw)
    return { ok: true, text }
  } catch (err) {
    return {
      ok: false,
      text: null,
      reason:
        'fetch_threw:' +
        (err instanceof Error ? err.message : String(err)).slice(0, 120),
    }
  }
}

/**
 * Strip VTT framing (`WEBVTT` header, cue ids, `00:00:00.000 --> 00:00:00.000`
 * timestamps) and return collapsed plaintext. Preserves speaker prefixes
 * like "John Smith:" on the line they appear on.
 *
 * Pure / unit-testable.
 */
export function cleanVtt(vtt: string): string {
  if (!vtt) return ''
  const lines = vtt.split(/\r?\n/)
  const out: string[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    // Header line.
    if (line === 'WEBVTT') continue
    // NOTE comments.
    if (line.startsWith('NOTE')) continue
    // Cue identifier (numeric or short identifier on its own line).
    if (/^\d+$/.test(line)) continue
    // Timestamp line: "00:00:00.000 --> 00:00:01.000".
    if (/-->/.test(line) && /\d{2}:\d{2}/.test(line)) continue
    // STYLE / REGION blocks.
    if (line.startsWith('STYLE') || line.startsWith('REGION')) continue
    // Strip inline <v Speaker>...</v> tags Zoom uses; keep speaker name.
    const stripped = line
      .replace(/<v\s+([^>]+)>/gi, '$1: ')
      .replace(/<\/v>/gi, '')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (stripped) out.push(stripped)
  }
  // Collapse consecutive duplicate lines (Zoom occasionally repeats).
  const dedup: string[] = []
  for (const l of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== l) dedup.push(l)
  }
  return dedup.join('\n').trim()
}
