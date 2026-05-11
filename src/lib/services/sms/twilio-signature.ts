/**
 * Twilio webhook signature verification.
 *
 * Twilio signs every webhook with `X-Twilio-Signature` as
 * Base64(HMAC-SHA1(authToken, fullUrl + sortedConcatenatedParams)).
 *
 * Algorithm per https://www.twilio.com/docs/usage/webhooks/webhooks-security:
 *   1. Take the full request URL (including any query string Twilio uses
 *      to call you).
 *   2. Sort POST body params alphabetically by key.
 *   3. For each (key, value) pair, append `key + value` to the URL.
 *   4. HMAC-SHA1 the resulting string using your account's auth token
 *      as the key.
 *   5. Base64-encode the digest.
 *   6. timingSafeEqual against the X-Twilio-Signature header.
 *
 * Pure function. No I/O. No env reads — the auth token is passed in so
 * the caller (route handler) can env-var-guard the route before invoking
 * verification.
 */

import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Verify a Twilio webhook signature.
 *
 * @param url - The full request URL Twilio called (must match exactly
 *              what's configured in the Twilio console — protocol +
 *              host + path + query string).
 * @param params - The form-encoded POST params as a Record. For media
 *                 messages Twilio sends them as form-urlencoded; the
 *                 caller is expected to have parsed them into a plain
 *                 object before passing in.
 * @param signatureHeader - The X-Twilio-Signature header value.
 * @param authToken - The venue's Twilio auth token.
 * @returns true when the signature matches.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null,
  authToken: string,
): boolean {
  if (!signatureHeader || !authToken) return false

  try {
    // Sort keys alphabetically, concatenate key + value pairs onto the URL.
    const sortedKeys = Object.keys(params).sort()
    let data = url
    for (const k of sortedKeys) {
      data += k + (params[k] ?? '')
    }

    const expected = createHmac('sha1', authToken)
      .update(Buffer.from(data, 'utf-8'))
      .digest('base64')

    const expectedBuf = Buffer.from(expected, 'utf-8')
    const actualBuf = Buffer.from(signatureHeader, 'utf-8')

    if (expectedBuf.length !== actualBuf.length) return false
    return timingSafeEqual(expectedBuf, actualBuf)
  } catch {
    return false
  }
}
