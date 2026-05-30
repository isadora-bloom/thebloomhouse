#!/usr/bin/env tsx
/**
 * Unit test — web-form visitor_id carry-forward (GC-13 wiring).
 *
 * Verifies `stitchWebFormVisits` wiring WITHOUT a database, via an injected
 * stitch spy + a chainable mock supabase. Locks the contract:
 *   - a row carrying visitor_id + email that resolves to EXACTLY ONE couple
 *     stitches (correct coupleId + visitorId forwarded);
 *   - a row with no visitor_id is never attempted;
 *   - 0 or >1 matching couples → skip (never guess / mis-attribute);
 *   - a throwing stitch is swallowed and does not abort the remaining rows.
 *
 * Pure (mocked I/O). Run: npx tsx scripts/test-web-form-visitor-stitch.ts
 */
import { stitchWebFormVisits } from '@/lib/services/crm-import/web-form'
import type { NormalisedLeadRow } from '@/lib/services/crm-import'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

/** Row factory — only the fields the stitch reads. */
function row(email: string | null, visitorId: string | null): NormalisedLeadRow {
  return {
    partner1_email: email,
    interactions: [
      { extracted_identity: visitorId ? { visitor_id: visitorId } : {} },
    ],
  } as unknown as NormalisedLeadRow
}

/** Chainable mock supabase. `byEmail` maps a primary_contact_email to the
 *  couples the query should return; absent → []. */
function mockSupabase(byEmail: Record<string, { id: string }[]>) {
  return {
    from(_table: string) {
      let email = ''
      const builder: Record<string, unknown> = {
        select() { return builder },
        eq(col: string, val: string) { if (col === 'primary_contact_email') email = val; return builder },
        is() { return builder },
        limit() { return Promise.resolve({ data: byEmail[email] ?? [], error: null }) },
      }
      return builder
    },
  } as never
}

const VENUE = 'venue-1'

async function main() {
  // --- Case 1: exactly one couple → stitch fires with the right args -------
  {
    const calls: Array<{ coupleId: string; anonVisitorId: string }> = []
    const stitch = async (a: { coupleId: string; anonVisitorId: string }) => {
      calls.push({ coupleId: a.coupleId, anonVisitorId: a.anonVisitorId })
      return { utmBound: true, visits: 3 }
    }
    const res = await stitchWebFormVisits({
      supabase: mockSupabase({ 'cara@x.com': [{ id: 'couple-C' }] }),
      venueId: VENUE,
      rows: [row('Cara@X.com', 'visitor-abc')],
      stitch,
    })
    check('unambiguous couple → stitch called once', calls.length === 1, calls)
    check('correct coupleId forwarded', calls[0]?.coupleId === 'couple-C', calls[0])
    check('visitor_id forwarded', calls[0]?.anonVisitorId === 'visitor-abc', calls[0])
    check('email lower-cased before lookup (matched cara@x.com)', calls.length === 1)
    check('result counts attempted=1 stitched=1', res.attempted === 1 && res.stitched === 1, res)
  }

  // --- Case 2: no visitor_id → never attempted -----------------------------
  {
    const calls: unknown[] = []
    const res = await stitchWebFormVisits({
      supabase: mockSupabase({ 'no@x.com': [{ id: 'couple-N' }] }),
      venueId: VENUE,
      rows: [row('no@x.com', null)],
      stitch: async () => { calls.push(1); return { utmBound: true, visits: 1 } },
    })
    check('row without visitor_id is not attempted', res.attempted === 0 && calls.length === 0, res)
  }

  // --- Case 3: zero matching couples → skip --------------------------------
  {
    const calls: unknown[] = []
    const res = await stitchWebFormVisits({
      supabase: mockSupabase({}), // no couple for this email yet
      venueId: VENUE,
      rows: [row('orphan@x.com', 'visitor-z')],
      stitch: async () => { calls.push(1); return { utmBound: true, visits: 1 } },
    })
    check('no couple yet → attempted but not stitched', res.attempted === 1 && res.stitched === 0 && calls.length === 0, res)
  }

  // --- Case 4: ambiguous (2 couples) → skip, never guess -------------------
  {
    const calls: unknown[] = []
    const res = await stitchWebFormVisits({
      supabase: mockSupabase({ 'dup@x.com': [{ id: 'c1' }, { id: 'c2' }] }),
      venueId: VENUE,
      rows: [row('dup@x.com', 'visitor-d')],
      stitch: async () => { calls.push(1); return { utmBound: true, visits: 1 } },
    })
    check('ambiguous match → skipped (no mis-attribution)', res.stitched === 0 && calls.length === 0, res)
  }

  // --- Case 5: throwing stitch swallowed; later rows still processed -------
  {
    const ok: string[] = []
    const stitch = async (a: { coupleId: string }) => {
      if (a.coupleId === 'BOOM') throw new Error('stitch blew up')
      ok.push(a.coupleId)
      return { utmBound: true, visits: 1 }
    }
    let threw = false
    let res: { attempted: number; stitched: number } | null = null
    try {
      res = await stitchWebFormVisits({
        supabase: mockSupabase({ 'bad@x.com': [{ id: 'BOOM' }], 'good@x.com': [{ id: 'couple-G' }] }),
        venueId: VENUE,
        rows: [row('bad@x.com', 'v1'), row('good@x.com', 'v2')],
        stitch,
      })
    } catch { threw = true }
    check('throwing stitch does not abort the batch', threw === false)
    check('the surviving row still stitched after the throw', ok.length === 1 && ok[0] === 'couple-G', ok)
    check('attempted counts both rows', res?.attempted === 2, res)
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — web-form visitor_id carry-forward (GC-13)`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
