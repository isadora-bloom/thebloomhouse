/**
 * writeOrLog — make a Supabase write's failure VISIBLE instead of silent.
 *
 * supabase-js returns `{ data, error }` rather than throwing, so a bare
 * `await supabase.from(t).insert(y)` that ignores the result drops a failed
 * write on the floor — no log, no trace (HARDENING-SCOPE Area 1). This helper
 * wraps such a write: it awaits it, and on error emits a structured
 * `db.write_failed` log event, then returns the SAME result object.
 *
 * Deliberately NON-throwing and control-flow-preserving: migrating a
 * swallowed `await x.insert(...)` to `await writeOrLog(x.insert(...), ctx)`
 * changes nothing except that a failure now gets logged. It is therefore
 * safe to apply mechanically without re-reasoning each call site's behaviour.
 *
 * Idempotent writes that intentionally tolerate a unique-violation pass
 * `{ ignoreCodes: ['23505'] }` so the expected conflict is not logged as an
 * error (mirrors the spine writers' 23505-as-success convention).
 *
 * The shared `check-swallowed-writes.mjs` ratchet counts un-wrapped
 * statement-level awaited inserts/upserts and only lets that number fall.
 */

import { logEvent } from '@/lib/observability/logger'

/** Minimal shape of a Supabase write response — only `error` is read. */
interface WriteResult {
  error: { message: string; code?: string } | null
}

export interface WriteOrLogCtx {
  /** Stable operation label for dashboards, e.g. 'tours.insert'. */
  op: string
  venueId?: string | null
  correlationId?: string | null
  actor?: string
  /** Postgres error codes to treat as non-errors (idempotent writes). */
  ignoreCodes?: readonly string[]
}

export async function writeOrLog<R extends WriteResult>(
  query: PromiseLike<R>,
  ctx: WriteOrLogCtx,
): Promise<R> {
  const res = await query
  const code = res.error?.code ?? ''
  if (res.error && !(ctx.ignoreCodes ?? []).includes(code)) {
    logEvent({
      level: 'error',
      msg: `db.write_failed:${ctx.op}`,
      event_type: 'db.write_failed',
      outcome: 'fail',
      venueId: ctx.venueId ?? null,
      correlationId: ctx.correlationId ?? null,
      actor: ctx.actor ?? 'db_write',
      data: { op: ctx.op, code: res.error.code ?? null, message: res.error.message },
    })
  }
  return res
}
