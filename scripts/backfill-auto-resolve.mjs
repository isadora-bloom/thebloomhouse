#!/usr/bin/env node
/**
 * One-time backfill: auto-resolve existing open conflicts.
 *
 * Anchor: TIER 2e (2026-05-14). Pre-mig-338, every legacy/computed
 * disagreement entered the coordinator review queue. With mig 338 +
 * the auto-resolve service, ~80-85% of those collapse to a system
 * rule:
 *
 *   destination (honeybook/calendly/...) → computed wins
 *   low-information (website/unset/null) + confidence >= 0.85 → computed wins
 *   confidence >= 0.95 → computed wins
 *
 * This script runs the backfill across all venues so the queue
 * drops without coordinator clicks.
 *
 * Pass --venue <uuid> to scope to one venue. Pass --apply to actually
 * write; default is dry-run with a summary.
 */
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v
}

const { createClient } = await import('@supabase/supabase-js')
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const { backfillAutoResolveOpenConflicts } = await import(
  '../src/lib/services/attribution/auto-resolve.ts'
)

const args = process.argv.slice(2)
const venueArgIdx = args.indexOf('--venue')
const scopedVenue = venueArgIdx >= 0 ? args[venueArgIdx + 1] : null
const apply = args.includes('--apply')

const { data: venues } = await sb.from('venues').select('id, name')
const targets = scopedVenue ? (venues ?? []).filter((v) => v.id === scopedVenue) : (venues ?? [])

console.log(`\n=== Auto-resolve backfill (TIER 2e / mig 338) ===\n`)
console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`)
console.log(`Venues: ${targets.length}\n`)

let totalResolved = 0
let totalRemaining = 0
const allErrors = []

for (const v of targets) {
  if (!apply) {
    // Dry-run: just count what WOULD resolve. We re-implement the
    // count-only path inline so we don't write.
    const { data: open } = await sb
      .from('attribution_events_live')
      .select('id, source_platform, confidence, conflict_with_legacy_source')
      .eq('venue_id', v.id)
      .not('conflict_with_legacy_source', 'is', null)
      .is('conflict_resolution_state', null)
      .limit(5000)
    let wouldResolve = 0
    let wouldRemain = 0
    for (const evt of open ?? []) {
      const legMatch = (evt.conflict_with_legacy_source ?? '').match(/legacy=([^\s]+)/i)
      const legacy = legMatch?.[1]?.toLowerCase() ?? ''
      const computed = (evt.source_platform ?? '').toLowerCase()
      const conf = evt.confidence
      const NEVER = ['honeybook', 'calendly', 'acuity', 'dubsado', 'aisle_planner', 'aisleplanner', 'tave', 'tave_studio']
      const LOW = ['website', 'unset', 'unknown', 'other', '']
      if (NEVER.includes(legacy)) wouldResolve++
      else if (LOW.includes(legacy) && conf >= 85) wouldResolve++
      else if (conf >= 95) wouldResolve++
      else wouldRemain++
    }
    console.log(
      `[DRY] ${v.name.padEnd(30)}  open=${(open?.length ?? 0).toString().padStart(4)}  would-resolve=${wouldResolve.toString().padStart(4)}  would-remain=${wouldRemain.toString().padStart(4)}`,
    )
    totalResolved += wouldResolve
    totalRemaining += wouldRemain
    continue
  }
  const result = await backfillAutoResolveOpenConflicts(sb, v.id)
  console.log(
    `${v.name.padEnd(30)}  resolved=${result.resolved.toString().padStart(4)}  remaining=${result.remaining.toString().padStart(4)}`,
  )
  totalResolved += result.resolved
  totalRemaining += result.remaining
  if (result.errors.length > 0) allErrors.push(...result.errors.map((e) => `[${v.name}] ${e}`))
}

console.log(`\nTotal resolved : ${totalResolved}`)
console.log(`Total remaining: ${totalRemaining}`)
if (allErrors.length > 0) {
  console.log(`\nErrors (${allErrors.length}):`)
  for (const e of allErrors.slice(0, 20)) console.log(`  ${e}`)
  if (allErrors.length > 20) console.log(`  ...and ${allErrors.length - 20} more`)
}
if (!apply) console.log(`\nDry-run. Pass --apply to write.`)
console.log()
