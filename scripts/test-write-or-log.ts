#!/usr/bin/env tsx
/**
 * Unit test — writeOrLog (HARDENING-SCOPE Area 1 foundation).
 *
 * Verifies the helper logs a failed write (instead of swallowing it),
 * stays silent on success + on an ignored idempotent code, and returns the
 * result object unchanged. logEvent(level:'error') routes to console.error,
 * so we capture that. Pure (no DB). Run: npx tsx scripts/test-write-or-log.ts
 */
import { writeOrLog } from '@/lib/db/write-or-log'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

/** A thenable that resolves to a Supabase-shaped { data, error } result. */
function fakeWrite<T>(result: T) {
  return { then: (r: (v: T) => unknown) => Promise.resolve(result).then(r) } as PromiseLike<T>
}

/** Capture console.error lines emitted during fn(). */
async function captureErr(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try { await fn() } finally { console.error = orig }
  return lines
}

async function main() {
  // success → no error log, result returned
  {
    let res: unknown
    const errs = await captureErr(async () => {
      res = await writeOrLog(fakeWrite({ data: { id: 'x' }, error: null }), { op: 'tours.insert', venueId: 'v1' })
    })
    check('success → no db.write_failed log', errs.every((l) => !l.includes('db.write_failed')), errs)
    check('success → result passes through', JSON.stringify(res) === JSON.stringify({ data: { id: 'x' }, error: null }), res)
  }

  // failure → logs db.write_failed with the op + message, still returns the result
  {
    let res: unknown
    const errs = await captureErr(async () => {
      res = await writeOrLog(
        fakeWrite({ data: null, error: { message: 'null value in column "signal_class"', code: '23502' } }),
        { op: 'interactions.insert', venueId: 'v1' },
      )
    })
    const logged = errs.find((l) => l.includes('db.write_failed'))
    check('failure → logs db.write_failed', Boolean(logged), errs)
    check('failure log carries the op', Boolean(logged && logged.includes('interactions.insert')), logged)
    check('failure log carries the error code', Boolean(logged && logged.includes('23502')), logged)
    check('failure → result still returned (non-throwing)', JSON.stringify(res) !== undefined && (res as { error: unknown }).error !== null)
  }

  // ignored idempotent code (23505) → no error log
  {
    const errs = await captureErr(async () => {
      await writeOrLog(
        fakeWrite({ data: null, error: { message: 'duplicate key', code: '23505' } }),
        { op: 'touchpoints.insert', venueId: 'v1', ignoreCodes: ['23505'] },
      )
    })
    check('ignored 23505 → no error log (idempotent write)', errs.every((l) => !l.includes('db.write_failed')), errs)
  }

  // a different error code is NOT ignored even when ignoreCodes is set
  {
    const errs = await captureErr(async () => {
      await writeOrLog(
        fakeWrite({ data: null, error: { message: 'fk violation', code: '23503' } }),
        { op: 'people.insert', ignoreCodes: ['23505'] },
      )
    })
    check('non-ignored code still logs even with ignoreCodes set', errs.some((l) => l.includes('db.write_failed')), errs)
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — writeOrLog`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
