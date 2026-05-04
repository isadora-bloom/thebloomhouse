/**
 * Stream XXX — first-touch precedence verify (UTM > attribution_events
 *               > weddings.source).
 *
 * Why
 * ---
 * Source Comparison's headline "bookings by source" tally currently
 * uses weddings.source as the credited channel for the first-touch
 * model. But when a Google / Knot / WW-driven inquiry eventually books
 * via HoneyBook, the import overwrites weddings.source = 'honeybook'
 * and the original ad-driven channel disappears from the tally.
 *
 * Live audit on Rixey before this stream landed:
 *   - $9.7K of 2025 Google Ads spend → 43 attributed inquiries → 0
 *     attributed bookings (per the headline).
 *   - The Knot $30K spend → 163 inquiries → 0 bookings.
 *   - HoneyBook → 0 inquiries → 40 bookings.
 *
 * That's not real. The Knot and Google almost certainly drove
 * SOMETHING that booked; the tally just couldn't see it because the
 * computeSourceFunnel first-touch branch read w.source (which the
 * HoneyBook import had rewritten).
 *
 * The fix: in attribution.ts::computeSourceFunnel, change the first-
 * touch model to credit the wedding's first-touch SIGNAL — preferring
 * weddings.utm_source (captured at inbound by the form), then falling
 * back to attribution_events.source_platform WHERE is_first_touch=true,
 * and only THEN to weddings.source for legacy / manual-entry weddings.
 *
 * What this verifies
 * ------------------
 *
 *   Two-tally comparison, both gated identically (terminal status
 *   AND contract_signed touchpoint per T5-Rixey-UUU — the funnel API's
 *   bookings semantics, NOT the wedding-rollup endpoint's looser
 *   "any terminal status counts" rule):
 *
 *     - LEGACY: groups every booked wedding by weddings.source (the
 *       pre-Stream-XXX behaviour). Reads w.source directly with no
 *       attribution_events / utm_source promotion.
 *     - NEW: calls computeSourceFunnel(RIXEY, { model: 'first_touch' })
 *       which now applies the precedence chain.
 *
 *   Both tallies use the same booked-cohort gate, so the totals MUST
 *   agree — the change redistributes credit between channels, never
 *   invents new bookings.
 *
 *   For each channel of interest (the_knot, google, wedding_wire,
 *   honeybook) we print before/after booking counts; the delta column
 *   is what coordinator-facing Source Comparison will show post-fix.
 *
 *   Note: the funnel-API booking total (e.g. 11 on Rixey today) is
 *   smaller than the rollup-endpoint booking total (51 on Rixey)
 *   because the funnel requires a contract_signed touchpoint. That gap
 *   is a SEPARATE concern (touchpoint-backfill is JJJ territory) and
 *   is intentionally not addressed by this stream — Stream XXX only
 *   reshapes credit assignment within the funnel API's existing
 *   booked-cohort definition.
 *
 * Run
 * ---
 *   npx tsx scripts/rixey-load/77-xxx-verify.ts
 *
 * Idempotent — read-only.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const CHANNELS_OF_INTEREST = ['the_knot', 'google', 'wedding_wire', 'honeybook']

function loadEnv(): Record<string, string> {
  // Worktree's CWD doesn't carry .env.local; fall back to the main
  // repo's copy. Both share the same Supabase project.
  const candidates = ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']
  let raw = ''
  for (const c of candidates) {
    try { raw = readFileSync(c, 'utf8'); break } catch { /* try next */ }
  }
  if (!raw) throw new Error('.env.local not found (looked in worktree + main repo)')
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
}

interface Tally {
  source: string
  bookings: number
  inquiries: number
}

/**
 * Pre-Stream-XXX first-touch tally — emulates the old funnel logic by
 * grouping every booked wedding by weddings.source directly. Uses the
 * SAME booking gate as computeSourceFunnel (terminal status AND a
 * contract_signed touchpoint exist) so the totals are directly
 * comparable to the new function's output.
 */
async function legacyFunnelTally(sb: SupabaseClient): Promise<Map<string, Tally>> {
  const { data: wedRows } = await sb
    .from('weddings')
    .select('id, source, status')
    .eq('venue_id', RIXEY_VENUE_ID)
    .is('merged_into_id', null)
  const weddings = (wedRows ?? []) as Array<{ id: string; source: string | null; status: string | null }>

  // Pre-fetch contract_signed touchpoints for the cohort so the gate
  // matches computeSourceFunnel's `booked` indicator.
  const ids = weddings.map((w) => w.id)
  const contractIds = new Set<string>()
  if (ids.length > 0) {
    const CHUNK = 200
    for (let i = 0; i < ids.length; i += CHUNK) {
      const c = ids.slice(i, i + CHUNK)
      const { data: tps } = await sb
        .from('wedding_touchpoints')
        .select('wedding_id')
        .eq('touch_type', 'contract_signed')
        .in('wedding_id', c)
      for (const t of (tps ?? []) as Array<{ wedding_id: string }>) contractIds.add(t.wedding_id)
    }
  }

  // Inquiry touchpoint: also pre-fetch so we can mirror computeSourceFunnel's
  // inquiry indicator (counts only weddings whose journey has any
  // 'inquiry' touch_type).
  const inquiryIds = new Set<string>()
  if (ids.length > 0) {
    const CHUNK = 200
    for (let i = 0; i < ids.length; i += CHUNK) {
      const c = ids.slice(i, i + CHUNK)
      const { data: tps } = await sb
        .from('wedding_touchpoints')
        .select('wedding_id')
        .eq('touch_type', 'inquiry')
        .in('wedding_id', c)
      for (const t of (tps ?? []) as Array<{ wedding_id: string }>) inquiryIds.add(t.wedding_id)
    }
  }

  const out = new Map<string, Tally>()
  for (const w of weddings) {
    const isTerminal = w.status === 'booked' || w.status === 'completed'
    const isBooked = isTerminal && contractIds.has(w.id)
    const isInquiry = inquiryIds.has(w.id)
    const src = w.source ?? '(unknown)'
    const cur = out.get(src) ?? { source: src, bookings: 0, inquiries: 0 }
    if (isInquiry) cur.inquiries += 1
    if (isBooked) cur.bookings += 1
    out.set(src, cur)
  }
  return out
}

async function main(): Promise<void> {
  const env = loadEnv()
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  console.log('=== Stream XXX: first-touch precedence verify ===\n')

  // ---- BEFORE: legacy first-touch tally (pre-Stream-XXX) ----
  console.log('--- BEFORE: bookings grouped by weddings.source (legacy first-touch) ---')
  const before = await legacyFunnelTally(sb)
  let beforeTotal = 0
  for (const ch of CHANNELS_OF_INTEREST) {
    const row = before.get(ch)
    console.log(`  ${ch.padEnd(20)} bookings=${row?.bookings ?? 0}  inquiries=${row?.inquiries ?? 0}`)
  }
  for (const row of before.values()) beforeTotal += row.bookings
  console.log(`  TOTAL across all sources: ${beforeTotal} bookings`)

  // ---- AFTER: Stream XXX precedence chain via computeSourceFunnel ----
  // Late-import to avoid pulling Next.js runtime into the script
  // entrypoint.
  console.log('\n--- AFTER: bookings via computeSourceFunnel (Stream XXX precedence) ---')
  const { computeSourceFunnel } = await import('../../src/lib/services/attribution')
  const rows = await computeSourceFunnel(RIXEY_VENUE_ID, { model: 'first_touch' })
  const afterByKey = new Map<string, typeof rows[number]>()
  for (const r of rows) afterByKey.set(r.source ?? '(unknown)', r)
  let afterTotal = 0
  for (const ch of CHANNELS_OF_INTEREST) {
    const row = afterByKey.get(ch)
    console.log(`  ${ch.padEnd(20)} bookings=${row?.bookings ?? 0}  inquiries=${row?.inquiries ?? 0}`)
  }
  for (const r of rows) afterTotal += r.bookings
  console.log(`  TOTAL across all sources: ${afterTotal} bookings`)

  // ---- Per-channel delta table ----
  console.log('\n--- DELTA: how the change redistributes credit ---')
  const allKeys = new Set<string>([
    ...Array.from(before.keys()),
    ...Array.from(afterByKey.keys()),
  ])
  const deltas: Array<{ source: string; before: number; after: number; delta: number }> = []
  for (const k of allKeys) {
    const b = before.get(k)?.bookings ?? 0
    const a = afterByKey.get(k)?.bookings ?? 0
    const d = a - b
    if (b === 0 && a === 0) continue
    deltas.push({ source: k, before: b, after: a, delta: d })
  }
  deltas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
  console.log('  source                before  after   delta')
  for (const d of deltas) {
    const sign = d.delta > 0 ? '+' : ''
    console.log(`  ${d.source.padEnd(20)}  ${String(d.before).padStart(5)}  ${String(d.after).padStart(5)}  ${sign}${d.delta}`)
  }

  // ---- Total invariant check ----
  console.log('\n--- INVARIANT: total bookings unchanged ---')
  console.log(`  before total = ${beforeTotal}`)
  console.log(`  after total  = ${afterTotal}`)
  const ok = beforeTotal === afterTotal
  console.log(ok
    ? '  PASS — total bookings unchanged (credits redistributed, not invented)'
    : `  FAIL — total drift of ${afterTotal - beforeTotal} (expected 0); see above per-channel detail`)

  console.log('\n=== Verify complete ===')
  if (!ok) process.exit(1)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
