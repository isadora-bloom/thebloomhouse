// ============================================================================
// Phase 2 step D.2 / §2.6 — re-merge operator-typed weddings columns after the
// wipe+reimport. CONSOLIDATION-PLAN-PHASED.md v2.1 §2.6 + PHASE-2-WIPE-MANIFEST.md
// §C + PHASE2-GO-CHECKLIST.md step D.2.
//
// THE PROBLEM IT SOLVES: the wipe empties `weddings`; HoneyBook import + Gmail
// backfill rebuild booked weddings with NEW ids, but four columns are
// OPERATOR-TYPED and NOT reproducible from any origin:
//   - calendly_qa          (jsonb)  ALSO the Calendly replay's payload source
//                                    (replayCalendlyFromQa reads it) — so this
//                                    re-merge MUST run BEFORE the Calendly replay.
//   - owner_note_to_couples (text)  free-text card shown to the couple
//   - owner_photo_url       (text)  operator-uploaded photo
//   - lead_source           (text)  MANUAL overrides only (see fill-only note)
//
// These were saved by phase2-export-danger.mjs into phase2-exports/weddings.json
// (full OLD rows) + people.json (stable emails per OLD wedding). This script
// re-attaches them to the NEW wedding rows, matched by couple email.
//
// MATCH: OLD wedding -> its emails (from OLD people.json, + the OLD wedding's own
// primary/partner_contact_email if present) -> NEW couple whose
// primary/partner_contact_email equals one of them (case-insensitive, not merged,
// source_wedding_id set) -> NEW wedding id = couples.source_wedding_id.
// UNAMBIGUOUS ONLY: 0 or >1 candidate NEW weddings -> skip + report, never guess.
//
// FILL-ONLY: a column is written only when the NEW row's value is empty AND the
// OLD value is present. This NEVER clobbers a value the reimport/derivation just
// produced — critical for `lead_source` (the derivation cron re-derives it; we
// only restore a manual override into a gap it left). Idempotent by construction.
//
// SAFETY: dry-run by default (prints the plan); --apply to write; the prod ref is
// refused without --allow-prod (scripts/_safety.mjs). Writes to prod are the point
// (the re-merge runs on prod after the prod wipe) — but must be explicit.
//
// Usage:
//   node scripts/phase2-remerge-operator-columns.mjs                      # dry-run vs .env.local
//   node scripts/phase2-remerge-operator-columns.mjs --apply              # execute (non-prod)
//   node scripts/phase2-remerge-operator-columns.mjs --apply --allow-prod # execute on PROD
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { parseSafetyFlags, assertNotProd, requireApply } from './_safety.mjs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const RIXEY_VENUE_NAME = 'Rixey Manor'
const EXPORT_DIR = 'phase2-exports'

// The operator-typed columns to restore, in (oldKey -> newColumn) form. The
// names match weddings exactly (migrations: lead_source mig per §C; calendly_qa;
// owner_note_to_couples + owner_photo_url).
const OPERATOR_FIELDS = [
  'calendly_qa',
  'owner_note_to_couples',
  'owner_photo_url',
  'lead_source',
]

const norm = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')
const hasVal = (v) =>
  v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '') &&
  !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)

/**
 * PURE matching/fill core — no DB, unit-tested in test-phase2-remerge.mjs.
 *
 * @param {object} args
 * @param {Array}  args.oldWeddings  rows from phase2-exports/weddings.json
 * @param {Array}  args.oldPeople    rows from phase2-exports/people.json
 * @param {Array}  args.newCouples   live couples: {source_wedding_id, primary_contact_email, partner_contact_email, merged_into_id}
 * @returns {{updates:Array, unmatched:Array, ambiguous:Array, nothingToCarry:Array, alreadyFull:Array}}
 */
export function planRemerge({ oldWeddings, oldPeople, newCouples }) {
  // OLD wedding id -> set of stable emails (people + the wedding's own contacts).
  const emailsByOldWedding = new Map()
  const add = (wid, e) => {
    if (!wid || !norm(e)) return
    if (!emailsByOldWedding.has(wid)) emailsByOldWedding.set(wid, new Set())
    emailsByOldWedding.get(wid).add(norm(e))
  }
  for (const p of oldPeople) add(p.wedding_id, p.email)
  for (const w of oldWeddings) { add(w.id, w.primary_contact_email); add(w.id, w.partner_contact_email) }

  // email -> set of NEW wedding ids (via couples, not merged, source_wedding_id set).
  const newWeddingsByEmail = new Map()
  const linkEmail = (e, wid) => {
    if (!norm(e) || !wid) return
    if (!newWeddingsByEmail.has(norm(e))) newWeddingsByEmail.set(norm(e), new Set())
    newWeddingsByEmail.get(norm(e)).add(wid)
  }
  for (const c of newCouples) {
    if (c.merged_into_id || !c.source_wedding_id) continue
    linkEmail(c.primary_contact_email, c.source_wedding_id)
    linkEmail(c.partner_contact_email, c.source_wedding_id)
  }

  const updates = []        // { newWeddingId, fields:{col:val}, viaEmail, oldWeddingId }
  const unmatched = []      // old weddings with operator data but no NEW wedding
  const ambiguous = []      // old weddings whose emails map to >1 NEW wedding
  const nothingToCarry = [] // old weddings with no operator-typed values
  const alreadyFull = []    // matched but NEW already has all the values (no-op)

  for (const w of oldWeddings) {
    const carry = {}
    for (const f of OPERATOR_FIELDS) if (hasVal(w[f])) carry[f] = w[f]
    if (Object.keys(carry).length === 0) { nothingToCarry.push(w.id); continue }

    const emails = [...(emailsByOldWedding.get(w.id) ?? [])]
    const candidates = new Set()
    for (const e of emails) for (const nw of (newWeddingsByEmail.get(e) ?? [])) candidates.add(nw)

    if (candidates.size === 0) { unmatched.push({ oldWeddingId: w.id, emails, carry: Object.keys(carry) }); continue }
    if (candidates.size > 1) { ambiguous.push({ oldWeddingId: w.id, emails, newWeddingIds: [...candidates] }); continue }

    const newWeddingId = [...candidates][0]
    const viaEmail = emails.find((e) => (newWeddingsByEmail.get(e) ?? new Set()).has(newWeddingId))
    updates.push({ newWeddingId, oldWeddingId: w.id, viaEmail, fields: carry })
  }

  return { updates, unmatched, ambiguous, nothingToCarry, alreadyFull }
}

// applyFill: given the live NEW wedding row, return only the fields that are
// genuinely empty on NEW (fill-only). Pure so it's testable. Returns {} when
// everything is already set (caller records alreadyFull).
export function fillOnly(plannedFields, newRow) {
  const out = {}
  for (const [col, val] of Object.entries(plannedFields)) {
    if (!hasVal(newRow?.[col])) out[col] = val
  }
  return out
}

// --- main (skipped under unit test, which only imports the pure fns) ----------
async function main() {
  const { apply, allowProd } = parseSafetyFlags(process.argv)
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8').split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
  )
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  assertNotProd(url, { allowProd })

  const wf = `${EXPORT_DIR}/weddings.json`
  const pf = `${EXPORT_DIR}/people.json`
  if (!existsSync(wf) || !existsSync(pf)) {
    console.error(`REFUSED: ${wf} + ${pf} required (run scripts/phase2-export-danger.mjs first).`)
    process.exit(1)
  }
  const oldWeddings = JSON.parse(readFileSync(wf, 'utf8'))
  const oldPeople = JSON.parse(readFileSync(pf, 'utf8'))

  const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  // Venue triple-check (same guard posture as the wipe).
  const { data: venue, error: vErr } = await sb
    .from('venues').select('id, name, is_demo').eq('id', RIXEY_VENUE_ID).single()
  if (vErr || !venue) { console.error(`SAFETY FAIL: venue not found (${vErr?.message}).`); process.exit(1) }
  if (venue.name !== RIXEY_VENUE_NAME || venue.is_demo) { console.error(`SAFETY FAIL: venue mismatch / is_demo.`); process.exit(1) }

  // Load live NEW couples (the join from email -> new wedding id).
  const newCouples = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('couples')
      .select('source_wedding_id, primary_contact_email, partner_contact_email, merged_into_id')
      .eq('venue_id', RIXEY_VENUE_ID).range(from, from + 999)
    if (error) { console.error(`couples read failed: ${error.message}`); process.exit(1) }
    newCouples.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }

  const plan = planRemerge({ oldWeddings, oldPeople, newCouples })
  console.log(`\nTarget: ${venue.name} on ${url}`)
  console.log(`OLD weddings: ${oldWeddings.length} · OLD people: ${oldPeople.length} · NEW couples (booked,unmerged): ${newCouples.filter((c) => c.source_wedding_id && !c.merged_into_id).length}`)
  console.log(`\nPlan: ${plan.updates.length} matched · ${plan.unmatched.length} unmatched · ${plan.ambiguous.length} ambiguous · ${plan.nothingToCarry.length} nothing-to-carry`)
  if (plan.unmatched.length) console.log(`  ⚠ unmatched (operator data with no NEW wedding): ${plan.unmatched.slice(0, 10).map((u) => u.oldWeddingId).join(', ')}${plan.unmatched.length > 10 ? ' …' : ''}`)
  if (plan.ambiguous.length) console.log(`  ⚠ ambiguous (email maps to >1 NEW wedding): ${plan.ambiguous.slice(0, 10).map((u) => u.oldWeddingId).join(', ')}${plan.ambiguous.length > 10 ? ' …' : ''}`)

  console.log(apply ? '\n=== APPLY (fill-only) ===' : '\n=== DRY RUN (counts only; --apply to write) ===')
  let filled = 0, already = 0, fieldCounts = {}
  for (const u of plan.updates) {
    // Re-read the NEW row so fill-only respects whatever the reimport set.
    const { data: cur, error } = await sb.from('weddings').select(`id, ${OPERATOR_FIELDS.join(', ')}`).eq('id', u.newWeddingId).single()
    if (error || !cur) { console.log(`  ${u.newWeddingId} read-fail: ${error?.message}`); continue }
    const toSet = fillOnly(u.fields, cur)
    if (Object.keys(toSet).length === 0) { already += 1; continue }
    for (const k of Object.keys(toSet)) fieldCounts[k] = (fieldCounts[k] ?? 0) + 1
    if (apply) {
      const { error: upErr } = await sb.from('weddings').update(toSet).eq('id', u.newWeddingId)
      if (upErr) { console.log(`  ${u.newWeddingId} UPDATE-fail: ${upErr.message}`); continue }
    }
    filled += 1
  }
  console.log(`  ${apply ? 'filled' : 'would fill'}: ${filled} wedding(s) · already-set (skipped): ${already}`)
  console.log(`  by column: ${JSON.stringify(fieldCounts)}`)
  if (!requireApply(apply, 'phase2-remerge-operator-columns')) process.exit(0)
  console.log('\nDone. Next per PHASE2-GO-CHECKLIST.md: Calendly replay (replayCalendlyFromQa now has its payloads back).')
}

// Only run main when invoked directly (not when imported by the unit test).
const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('phase2-remerge-operator-columns.mjs')
if (isDirectRun) main()
