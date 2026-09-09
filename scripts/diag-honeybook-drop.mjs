#!/usr/bin/env node
/**
 * diag-honeybook-drop.mjs — READ-ONLY diagnostic.
 *
 * November plan finding 2 (W10): HoneyBook inbound fell from roughly
 * 13/8/11 a month to 6/2/2 in spring and nobody triaged it. The open
 * question is whether that's a real demand drop or the format-change
 * failure mode (see the Knot regression, April-June 2026) where the
 * relay's sender/subject shape moved and Bloom's classifier stopped
 * recognising HoneyBook mail as HoneyBook mail. This script reports
 * the raw material for that call — it does NOT decide for you.
 *
 * WHAT IT DOES
 *   1. Counts inbound `interactions` per calendar month for the last 18
 *      months, split by:
 *        - classic  : from_email domain contains "honeybook"
 *        - shaped   : from_email does NOT look like honeybook.com but the
 *                     subject or body_preview mentions "honeybook" anyway
 *                     (this is the format-change tell — the pipeline's
 *                     honeybook classifier keys off from_email, so a
 *                     relay/domain change lands rows here, not in
 *                     "classic", even though they are still HoneyBook mail).
 *   2. Lists every distinct sender domain seen across both buckets, with
 *      counts and first/last-seen dates, so a domain that appeared
 *      partway through the window (the actual signature of a relay
 *      format change) is visible at a glance.
 *   3. Lists a small sample of subject lines per domain so the operator
 *      can eyeball whether the shape actually changed.
 *
 * WHAT IT DOES NOT DO
 *   - It does not write anything. Every Supabase call below is wrapped
 *     in a proxy (see makeReadOnlyClient) that throws if ANYTHING but
 *     .select()/.count reaches the network. That is deliberate belt-
 *     and-braces: this script must stay safe to run against production
 *     even while a reimport is in flight, without a human having to
 *     re-audit every query by hand.
 *   - There is no --apply flag and none should ever be added. If you
 *     need to fix a misclassified relay, that is a separate, reviewed
 *     change to the ingestion classifier — not this script.
 *
 * USAGE
 *   node scripts/diag-honeybook-drop.mjs [--venue=<uuid>] [--months=18]
 *
 * If --venue is omitted and the project has exactly one active venue,
 * that venue is used automatically; otherwise the script lists active
 * venues and exits, asking for --venue explicitly.
 *
 * NOT RUN as part of this change — the operator is mid-reimport today
 * (2026-09-08) and this script talks to production Supabase. Read the
 * source, run it yourself when the reimport is done.
 */

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Guard 1: no --apply, ever. This script has no write mode; a stray
// --apply on the command line (muscle memory from the --apply/--allow-prod
// scripts elsewhere in scripts/) must fail loudly, not be silently ignored.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
if (argv.some((a) => a === '--apply' || a === '--allow-prod' || a.startsWith('--apply='))) {
  console.error(
    '[diag-honeybook-drop] This script is read-only and has no write mode. ' +
      'Remove --apply / --allow-prod and run again.',
  )
  process.exit(1)
}

function getArg(name, fallback = undefined) {
  const prefix = `--${name}=`
  const hit = argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const VENUE_ARG = getArg('venue', null)
const MONTHS_BACK = Number.parseInt(getArg('months', '18'), 10) || 18

// ---------------------------------------------------------------------------
// Env — same .env.local parsing pattern as the other scripts/diag-*.mjs
// files. .env.local points at PRODUCTION (see CLAUDE.md / November plan
// shared rules) — that is exactly why this script is read-only-enforced.
// ---------------------------------------------------------------------------

if (!existsSync('.env.local')) {
  console.error('[diag-honeybook-drop] .env.local not found. Run this from the repo root.')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[diag-honeybook-drop] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Guard 2: read-only client wrapper. Anything reaching .insert / .update /
// .upsert / .delete on a table builder throws before it can hit the
// network. .select and the count-only head request are the only paths
// left open. This is defence-in-depth on top of "the script just doesn't
// call those methods" — if a future edit to this file adds a write by
// mistake, it fails immediately and loudly instead of quietly mutating
// production.
// ---------------------------------------------------------------------------

const WRITE_METHODS = ['insert', 'update', 'upsert', 'delete', 'rpc']

function makeReadOnlyClient(url, key) {
  const real = createClient(url, key, { auth: { persistSession: false } })
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table) => {
          const builder = target.from(table)
          return new Proxy(builder, {
            get(bTarget, bProp, bReceiver) {
              if (typeof bProp === 'string' && WRITE_METHODS.includes(bProp)) {
                throw new Error(
                  `[diag-honeybook-drop] REFUSED: attempted "${bProp}" on table "${table}". ` +
                    `This script is read-only (select/count only) by design.`,
                )
              }
              const value = Reflect.get(bTarget, bProp, bReceiver)
              return typeof value === 'function' ? value.bind(bTarget) : value
            },
          })
        }
      }
      if (typeof prop === 'string' && WRITE_METHODS.includes(prop)) {
        throw new Error(
          `[diag-honeybook-drop] REFUSED: attempted top-level "${String(prop)}" call. ` +
            `This script is read-only (select/count only) by design.`,
        )
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const sb = makeReadOnlyClient(SUPABASE_URL, SERVICE_KEY)

// ---------------------------------------------------------------------------
// Venue resolution
// ---------------------------------------------------------------------------

async function resolveVenueId() {
  if (VENUE_ARG) return VENUE_ARG

  const { data: venues, error } = await sb
    .from('venues')
    .select('id, business_name')
    .eq('active', true)

  if (error) {
    console.error('[diag-honeybook-drop] Failed to list venues:', error.message)
    process.exit(1)
  }
  if (!venues || venues.length === 0) {
    console.error('[diag-honeybook-drop] No active venues found.')
    process.exit(1)
  }
  if (venues.length === 1) return venues[0].id

  console.error('[diag-honeybook-drop] Multiple active venues found — pass --venue=<uuid>:')
  for (const v of venues) console.error(`  ${v.id}  ${v.business_name ?? '(unnamed)'}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Classification — mirrors deriveIngestionChannel's honeybook branch in
// lib/services/ingestion-volume-monitor.ts (from_email contains
// "honeybook") for the "classic" bucket, plus a looser subject/body scan
// for the "shaped" bucket so a relay/domain change still surfaces here
// instead of silently vanishing into "direct_email".
// ---------------------------------------------------------------------------

function domainOf(email) {
  if (!email) return '(no sender)'
  const at = email.lastIndexOf('@')
  return at === -1 ? email.toLowerCase() : email.slice(at + 1).toLowerCase()
}

function isClassicHoneyBook(row) {
  return (row.from_email ?? '').toLowerCase().includes('honeybook')
}

function mentionsHoneyBook(row) {
  const hay = `${row.subject ?? ''} ${row.body_preview ?? ''}`.toLowerCase()
  return hay.includes('honeybook')
}

function monthKey(iso) {
  const d = new Date(iso)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Fetch — paginated inbound email interactions over the lookback window.
// Selects only the columns needed; no PII beyond what's already visible
// in the inbox UI (sender address/name, subject, a body preview).
// ---------------------------------------------------------------------------

async function fetchInboundEmails(venueId, sinceIso) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('interactions')
      .select('timestamp, from_email, from_name, subject, body_preview, type')
      .eq('venue_id', venueId)
      .eq('direction', 'inbound')
      .eq('type', 'email')
      .gte('timestamp', sinceIso)
      .order('timestamp', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[diag-honeybook-drop] Failed to fetch interactions:', error.message)
      process.exit(1)
    }
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const venueId = await resolveVenueId()

  const now = new Date()
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHS_BACK, 1))
  const sinceIso = since.toISOString()

  console.log(`[diag-honeybook-drop] venue=${venueId}  window=${sinceIso.slice(0, 10)} .. now  (READ-ONLY)`)

  const rows = await fetchInboundEmails(venueId, sinceIso)
  console.log(`[diag-honeybook-drop] fetched ${rows.length} inbound email interactions`)

  const classic = rows.filter(isClassicHoneyBook)
  const shaped = rows.filter((r) => !isClassicHoneyBook(r) && mentionsHoneyBook(r))

  // ---- 1. Per-month counts, classic vs shaped ----
  const monthly = new Map() // monthKey -> { classic, shaped }
  for (const r of classic) {
    const k = monthKey(r.timestamp)
    const cur = monthly.get(k) ?? { classic: 0, shaped: 0 }
    cur.classic += 1
    monthly.set(k, cur)
  }
  for (const r of shaped) {
    const k = monthKey(r.timestamp)
    const cur = monthly.get(k) ?? { classic: 0, shaped: 0 }
    cur.shaped += 1
    monthly.set(k, cur)
  }

  console.log('\n=== Monthly HoneyBook-relay inbound (last %d months) ==='.replace('%d', String(MONTHS_BACK)))
  console.log('month       classic  shaped  total')
  const sortedMonths = [...monthly.keys()].sort()
  for (const k of sortedMonths) {
    const { classic: c, shaped: s } = monthly.get(k)
    console.log(`${k}     ${String(c).padStart(7)}  ${String(s).padStart(6)}  ${String(c + s).padStart(5)}`)
  }
  if (sortedMonths.length === 0) {
    console.log('(no HoneyBook-relay-shaped inbound found in this window)')
  }

  // ---- 2. Distinct sender domains ----
  const byDomain = new Map() // domain -> { count, first, last, classic: bool }
  for (const r of [...classic, ...shaped]) {
    const d = domainOf(r.from_email)
    const entry = byDomain.get(d) ?? { count: 0, first: r.timestamp, last: r.timestamp, classic: isClassicHoneyBook(r) }
    entry.count += 1
    if (r.timestamp < entry.first) entry.first = r.timestamp
    if (r.timestamp > entry.last) entry.last = r.timestamp
    byDomain.set(d, entry)
  }

  console.log('\n=== Distinct sender domains (HoneyBook-relay-shaped mail) ===')
  console.log('domain                              bucket   count  first-seen   last-seen')
  const sortedDomains = [...byDomain.entries()].sort((a, b) => b[1].count - a[1].count)
  for (const [domain, e] of sortedDomains) {
    const bucket = e.classic ? 'classic' : 'shaped '
    console.log(
      `${domain.padEnd(35)} ${bucket}  ${String(e.count).padStart(5)}  ` +
        `${e.first.slice(0, 10)}   ${e.last.slice(0, 10)}`,
    )
  }
  if (sortedDomains.length === 0) {
    console.log('(none)')
  }

  // ---- 3. Sample subjects per domain — eyeball the relay shape ----
  console.log('\n=== Sample subject lines per domain (up to 3 each) ===')
  for (const [domain] of sortedDomains) {
    const samples = [...classic, ...shaped]
      .filter((r) => domainOf(r.from_email) === domain)
      .slice(-3)
    console.log(`\n-- ${domain} --`)
    for (const s of samples) {
      console.log(`  ${s.timestamp.slice(0, 10)}  "${(s.subject ?? '(no subject)').slice(0, 100)}"`)
    }
  }

  console.log(
    '\n[diag-honeybook-drop] Done. This is a report only — no rows were changed. ' +
      'Compare "classic" vs "shaped" per month: if shaped mail starts appearing where ' +
      'classic used to be, that is a relay format change, not a real demand drop.',
  )
}

main().catch((err) => {
  console.error('[diag-honeybook-drop] Fatal:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
