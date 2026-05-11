/**
 * Zoom webhook signature verification.
 *
 * Zoom signs every webhook with two headers:
 *   x-zm-request-timestamp: <unix-timestamp>
 *   x-zm-signature:         v0=<hex-sha256-hmac>
 *
 * The signed message is `"v0:" + timestamp + ":" + rawBody` and the
 * HMAC key is the venue's `ZOOM_WEBHOOK_SECRET` (Secret Token in the
 * Zoom App's Feature configuration). See:
 *   https://developers.zoom.us/docs/api/rest/webhook-reference/#verify-webhook-events
 *
 * Pure function. No env reads — the secret is passed in so the route
 * handler can env-var-guard before invoking.
 *
 * Replay protection: timestamp must be within 5 minutes of "now" by
 * default. Zoom's documented tolerance is 5 minutes.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export interface ZoomSignatureInput {
  /** Raw request body (must be exactly what Zoom POSTed; no JSON.parse + stringify roundtrip). */
  rawBody: string
  /** Value of the x-zm-request-timestamp header. */
  timestampHeader: string | null
  /** Value of the x-zm-signature header (e.g. "v0=abc123..."). */
  signatureHeader: string | null
  /** Zoom Secret Token for this app. */
  secret: string
  /** Optional override for replay tolerance. Defaults to 300s. */
  toleranceSeconds?: number
}

export function verifyZoomSignature(input: ZoomSignatureInput): boolean {
  const {
    rawBody,
    timestampHeader,
    signatureHeader,
    secret,
    toleranceSeconds = 300,
  } = input

  if (!timestampHeader || !signatureHeader || !secret) return false

  try {
    // Reject stale events.
    const tsNum = parseInt(timestampHeader, 10)
    if (!Number.isFinite(tsNum)) return false
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - tsNum) > toleranceSeconds) return false

    // Zoom signature header is "v0=<hex-digest>".
    const expectedDigest = createHmac('sha256', secret)
      .update(`v0:${timestampHeader}:${rawBody}`, 'utf-8')
      .digest('hex')
    const expectedHeader = `v0=${expectedDigest}`

    const expectedBuf = Buffer.from(expectedHeader, 'utf-8')
    const actualBuf = Buffer.from(signatureHeader, 'utf-8')

    if (expectedBuf.length !== actualBuf.length) return false
    return timingSafeEqual(expectedBuf, actualBuf)
  } catch {
    return false
  }
}

/**
 * Zoom's webhook-validation handshake. When you save a new webhook
 * endpoint in Zoom, they POST one `endpoint.url_validation` event with
 * a plainToken; the handler is expected to return
 * `{ plainToken, encryptedToken: HMAC-SHA256(secret, plainToken) }`
 * within 3 seconds.
 *
 * Use this in your route handler when event.event === 'endpoint.url_validation'.
 */
export function buildZoomValidationResponse(
  plainToken: string,
  secret: string,
): { plainToken: string; encryptedToken: string } {
  const encryptedToken = createHmac('sha256', secret)
    .update(plainToken, 'utf-8')
    .digest('hex')
  return { plainToken, encryptedToken }
}
