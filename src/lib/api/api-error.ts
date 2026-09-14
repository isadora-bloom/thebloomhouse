/**
 * Shared API error responder (W67, 2026-09-14 verification gap).
 *
 * The 2026-09-14 verification pass found roughly ninety route handlers that
 * echoed a caught error's `.message` straight into the JSON body they sent
 * back to the browser (`NextResponse.json({ error: error.message }, ...)`),
 * plus a wider set that logged the raw `err` object to `console.error`
 * without going through `redactError`. Both are the same mistake T3
 * insights already had to fix (see check-no-raw-err-logs-in-t3.mjs): a
 * Postgres constraint message, a Supabase RLS denial, an Anthropic 4xx —
 * all of them can and do echo prompt content, row values, or internal
 * schema detail. That is fine in a server log; it is not fine in a
 * response body a curious client can read.
 *
 * apiError() is the one place that gap gets closed. It:
 *   - mints (or reuses) a correlation id
 *   - logs the real error server-side through redactError, tagged with
 *     that id, so an operator report ("I got an error, id abc123") can be
 *     traced back to the actual failure in the logs
 *   - returns a generic message plus the id to the client — never the
 *     underlying error text
 *
 * Usage (status defaults to 500, the overwhelming majority of call sites):
 *
 *   } catch (err) {
 *     return apiError(err)
 *   }
 *
 *   if (error) return apiError(error, undefined, 422)
 *
 * Pass an existing correlation id (e.g. one already threaded through
 * `processIncomingEmail`) as the second argument to keep the id consistent
 * across a request; omit it and one is minted here.
 */
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { redactError } from '@/lib/observability/redact'

const GENERIC_MESSAGE = 'Something went wrong. Please try again.'

export function apiError(
  err: unknown,
  correlationId: string = randomUUID(),
  status = 500,
): NextResponse {
  console.error(`[api:${correlationId}]`, redactError(err))
  return NextResponse.json(
    { error: GENERIC_MESSAGE, correlationId },
    { status },
  )
}
