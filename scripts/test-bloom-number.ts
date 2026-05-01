/**
 * Unit + integration tests for the Bloom number .B graduation pipeline.
 *
 * Pure-function tests cover formatBloomNumber. Integration test exercises
 * migration 124's BEFORE UPDATE trigger by inserting a fresh inquiry and
 * flipping its status to 'booked'.
 *
 * Run with: npx tsx scripts/test-bloom-number.ts
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { formatBloomNumber } from '../src/lib/bloom-number/format'

let pass = 0
let fail = 0

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

assertEq(formatBloomNumber('HM-0847', null), 'HM-0847', 'no extension renders base code')
assertEq(formatBloomNumber('HM-0847', undefined), 'HM-0847', 'undefined extension renders base code')
assertEq(formatBloomNumber('HM-0847', ''), 'HM-0847', 'empty-string extension renders base code')
assertEq(formatBloomNumber('HM-0847', 'B'), 'HM-0847.B', 'B extension renders with dot')
assertEq(formatBloomNumber('CF-0001', 'C'), 'CF-0001.C', 'forward-compat: any single letter renders')
assertEq(formatBloomNumber(null, 'B'), '', 'no code returns empty string')
assertEq(formatBloomNumber(undefined, 'B'), '', 'undefined code returns empty string')
assertEq(formatBloomNumber('', 'B'), '', 'empty code returns empty string')

// ---------------------------------------------------------------------------
// Integration test — exercises migration 124 trigger end-to-end
// ---------------------------------------------------------------------------
// Gracefully skipped when .env.local is absent or service-role key is
// missing (CI runs the pure-function asserts only; live-Supabase tests
// are run locally / in the e2e gate per .github/workflows/ci.yml).

let env: Record<string, string> = {}
try {
  env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
} catch {
  // .env.local not present (CI). Integration block self-skips below.
}

const integrationEnabled = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY,
)

const sb = integrationEnabled
  ? createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null

// Use Hawthorne Manor demo venue (per scripts/apply-migrations.mjs convention).
const HAW = '22222222-2222-2222-2222-222222222201'

async function runIntegration() {
  if (!sb) {
    console.log('[integration] skipped — .env.local or service-role key missing')
    return
  }
  let weddingId: string | null = null
  try {
    // Insert as inquiry — trigger should NOT stamp code_extension.
    const { data: inserted, error: insErr } = await sb
      .from('weddings')
      .insert({ venue_id: HAW, status: 'inquiry', notes: '_t1c_trigger_probe' })
      .select('id, code_extension')
      .single()

    if (insErr || !inserted) {
      console.error('SKIP integration: insert failed:', insErr?.message)
      return
    }
    weddingId = inserted.id as string
    assertEq(inserted.code_extension, null, 'fresh inquiry has NULL code_extension')

    // Flip to booked — trigger fires.
    const { error: updErr } = await sb
      .from('weddings')
      .update({ status: 'booked' })
      .eq('id', weddingId)

    if (updErr) {
      console.error('FAIL integration: status update errored:', updErr.message)
      fail++
      return
    }

    const { data: afterRow } = await sb
      .from('weddings')
      .select('code_extension')
      .eq('id', weddingId)
      .single()
    assertEq(afterRow?.code_extension, 'B', 'status=booked stamps code_extension=B')

    // Idempotence: re-update to booked, extension should still be B (and
    // explicit override should also stick if a coordinator sets a different
    // value — we don't, but the column allows it).
    const { error: rebookErr } = await sb
      .from('weddings')
      .update({ status: 'booked' })
      .eq('id', weddingId)
    if (rebookErr) {
      console.error('FAIL integration: rebook errored:', rebookErr.message)
      fail++
      return
    }
    const { data: afterRebook } = await sb
      .from('weddings')
      .select('code_extension')
      .eq('id', weddingId)
      .single()
    assertEq(afterRebook?.code_extension, 'B', 'idempotent rebook keeps code_extension=B')

    // Status flip to completed (already-booked → completed) doesn't re-stamp.
    const { error: completeErr } = await sb
      .from('weddings')
      .update({ status: 'completed' })
      .eq('id', weddingId)
    if (completeErr) {
      console.error('FAIL integration: complete errored:', completeErr.message)
      fail++
      return
    }
    const { data: afterComplete } = await sb
      .from('weddings')
      .select('code_extension')
      .eq('id', weddingId)
      .single()
    assertEq(afterComplete?.code_extension, 'B', 'booked → completed leaves extension=B')
  } finally {
    if (weddingId) {
      // Clean up. people / client_codes rows the auto_generate_client_code
      // trigger created cascade via FKs.
      await sb.from('weddings').delete().eq('id', weddingId)
    }
  }
}

runIntegration()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('integration crashed:', err)
    process.exit(1)
  })
