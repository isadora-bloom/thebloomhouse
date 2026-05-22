/**
 * resolve-partner-dups.ts
 * ---------------------------------------------------------------------------
 * Data-integrity remediation for the Phase-1 consolidation.
 *
 * THE FINDING
 * -----------
 * Migration 367 (`367_people_partner_role_unique.sql`) creates a PARTIAL
 * UNIQUE INDEX enforcing "at most one live person per (venue, wedding, role)"
 * for the partner1/partner2 roles. It aborts on apply because 15
 * (venue_id, wedding_id, role) groups already contain duplicate partner rows
 * (Liam-Hunt-class duplicate-identity rows: a query-then-insert TOCTOU race in
 * `enrichExistingPartner2` minted a second partner row before the first
 * committed).
 *
 * Migration 367's own remediation note says: resolve each group through the
 * merge cascade (merged_into_id) so the surviving row is canonical and the
 * losers carry merged_into_id — then re-run the migration. This script does
 * exactly that, against the disposable consolidation Supabase branch.
 *
 * TWO CLASSES OF GROUP (classified, NOT blind-merged)
 * ---------------------------------------------------
 *  - TRUE DUPLICATE  : the 2+ rows are the same human (identical / variant
 *                      name, one a name-only stub of the other). -> MERGE:
 *                      soft-tombstone the loser into the survivor.
 *  - DISTINCT MIS-ROLED : the 2 rows are two different humans both stamped
 *                      the same role (a wedding whose two partners both got
 *                      role='partner2'). -> RE-ROLE one row to the opposite
 *                      partner role. Do NOT merge.
 *
 * MERGE APPROACH — REPLICATED, NOT IMPORTED
 * -----------------------------------------
 * The canonical cascade is `softTombstonePerson` in
 * `src/lib/services/identity/merge-people.ts`. It is callable standalone
 * (it takes a SupabaseClient). However it is authored as an ESM module that
 * lives behind the `@/` path alias and `mergePeople` (its sibling) does a
 * dynamic `import('@/lib/services/attribution/touchpoints')`. To keep this
 * remediation script fully standalone and free of alias-resolution risk, the
 * `softTombstonePerson` effect is REPLICATED here EXACTLY:
 *   1. Reassign every child row FK'd to the loser -> survivor:
 *        interactions.person_id, contacts.person_id,
 *        tangential_signals.matched_person_id.
 *      (drafts / engagement_events / weddings reassignment in the canonical
 *       cascade only fires when the two people belong to DIFFERENT weddings;
 *       every group here is a single wedding, so that branch is a no-op and
 *       is intentionally omitted.)
 *   2. Backfill non-null fields (email/phone/first_name/last_name) from loser
 *      -> survivor where the survivor's value is null; union external_ids.
 *   3. Write a `person_merges` audit row (tier 'high', soft_tombstone signal).
 *   4. Set the loser's `merged_into_id` to the survivor (soft-tombstone — the
 *      row survives for forensic audit per the Constitution; it is NOT
 *      hard-deleted).
 * This is byte-for-byte the documented behaviour of `softTombstonePerson`.
 *
 * SAFETY
 * ------
 *  - Targets ONLY the 15 groups hard-coded below. Touches nothing else.
 *  - Idempotent: a group already showing exactly one live target-role row is
 *    skipped. Re-running is safe.
 *  - Logs the before-state and the action for every group.
 *  - DRY-RUN by default. Pass --apply to write.
 *
 * CREDENTIALS
 * -----------
 * The branch URL + service_role key are read from env at run time. They are
 * NEVER written into this file.
 *
 *   BRANCH_URL=... BRANCH_KEY=... npx tsx scripts/resolve-partner-dups.ts            # dry-run
 *   BRANCH_URL=... BRANCH_KEY=... npx tsx scripts/resolve-partner-dups.ts --apply    # apply
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// The 15 offending groups + per-group remediation decision.
// ---------------------------------------------------------------------------
// `action`:
//   'merge'  — TRUE DUPLICATE. Soft-tombstone every non-survivor into the
//              survivor. `survivorHint` names the row to keep (by id prefix);
//              if omitted the survivor is chosen by completeness then oldest.
//   'rerole' — DISTINCT MIS-ROLED. `keepRoleId` keeps the queried role; the
//              other live row in that role flips to `flipToRole`.
// Every decision below is justified in the run report; `note` carries the
// one-line reasoning so the log is self-documenting.

type GroupAction =
  | {
      kind: 'merge'
      survivorIdPrefix?: string // id prefix of the row to keep, if a specific row is preferred
      note: string
    }
  | {
      kind: 'rerole'
      keepRoleIdPrefix: string // id prefix of the row that KEEPS the queried role
      flipToRole: 'partner1' | 'partner2'
      note: string
    }
  | {
      kind: 'detach'
      // id prefix of the row to detach from the wedding (wedding_id -> NULL).
      // Use when a row is a DISTINCT human who does not belong to this couple
      // at all (and cannot be re-roled because the opposite role is occupied
      // by the genuine partner). The detached person survives as an orphan
      // for the identity pipeline to re-place.
      detachIdPrefix: string
      note: string
    }

interface Group {
  n: number
  venueId: string
  weddingId: string
  role: 'partner1' | 'partner2'
  action: GroupAction
}

const GROUPS: Group[] = [
  {
    n: 1,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '3e6384fb-2ce0-4e5b-94b8-840f923f09e1',
    role: 'partner2',
    action: {
      kind: 'merge',
      survivorIdPrefix: '963ab038', // the row WITH a phone — stronger identity
      note: 'Two partner2 rows both "Dale Roop"; keep the one carrying a phone.',
    },
  },
  {
    n: 2,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: 'efd7cac1-ec0d-41d5-92bb-6b410eee5a69',
    role: 'partner2',
    action: {
      kind: 'merge',
      // both rows identical ("John Paul Ricks", no contact) — survivor = oldest
      note: 'Two partner2 rows both "John Paul Ricks", no contact on either; keep oldest.',
    },
  },
  {
    n: 3,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '7338d020-0aba-4321-9e16-166f0e350189',
    role: 'partner2',
    action: {
      kind: 'merge',
      note: 'Two partner2 rows both "Ben Ortt", no contact on either; keep oldest.',
    },
  },
  {
    n: 4,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '6777b23e-b141-44ff-9fe5-673a322e8d61',
    role: 'partner2',
    action: {
      kind: 'merge',
      survivorIdPrefix: '7b6a9876', // "Stephanie Lopez" — the genuine partner2
      note:
        'partner1 is "Jancarlo Matos". The two partner2 rows are "Stephanie Lopez" ' +
        '(genuine partner2) and "JC Matos" (= Jancarlo Matos, a duplicate of ' +
        'partner1 mis-stamped partner2). Keeping Stephanie Lopez as the live ' +
        'partner2 makes the group satisfy the one-per-role invariant. "JC Matos" ' +
        'is soft-tombstoned into Stephanie within this group; its forensic row ' +
        'survives via merged_into_id. Flagged in the report: ideally "JC Matos" ' +
        'would tombstone into partner1 Jancarlo Matos, but that is a cross-role ' +
        'identity call outside this index-unblocking scope — left as a report note.',
    },
  },
  {
    n: 5,
    venueId: '22222222-2222-2222-2222-222222222202',
    weddingId: '44444444-4444-4444-4444-444444000212',
    role: 'partner1',
    action: {
      kind: 'detach',
      detachIdPrefix: 'eeeeeeee-0000-0000-0000-00000000b001', // "James Osei"
      note:
        'DEMO venue. Two partner1 rows: "James Osei" (eeeeeeee-...b001, ' +
        'jamesosei@outlook.com) and "Ella Turner" (cb1236bf, ' +
        'ella.turner@email.com). partner2 is "Alex Turner" (alex.turner@email.com). ' +
        'PROVENANCE: supabase/seed-dedup-sequences.sql Scenario B DELIBERATELY ' +
        'inserts "James Osei" as partner1 on this wedding purely as a ' +
        'dedup/match-queue demo fixture (it has a sibling row ...b002 on a ' +
        'different wedding and a client_match_queue pairing). "Ella Turner" + ' +
        '"Alex Turner" share a surname and were inserted together (identical ' +
        'created_at) — they are the genuine couple. James Osei is NOT a partner ' +
        'of this couple, so this is neither a true-duplicate (different humans) ' +
        'nor a clean re-role (the opposite role partner2 is already occupied by ' +
        'the genuine Alex Turner — flipping James there would just move the ' +
        'duplication). Correct resolution: DETACH James Osei from this wedding ' +
        '(wedding_id -> NULL). He survives as an orphan person + keeps his ...b002 ' +
        'sibling row, and the wedding is left with exactly Ella(partner1) + ' +
        'Alex(partner2). Non-destructive and unblocks the index.',
    },
  },
  {
    n: 6,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: 'ebbcb72d-3f91-4cef-b44a-f7eb8c205eb1',
    role: 'partner2',
    action: {
      kind: 'merge',
      note: 'Two partner2 rows both "George Berbakos", same phone; keep oldest.',
    },
  },
  {
    n: 7,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '24ccd1fc-ddc5-4f8b-a969-906bd7130576',
    role: 'partner2',
    action: {
      kind: 'merge',
      note: 'Two partner2 rows both "Luke Koszycki", same phone; keep oldest.',
    },
  },
  {
    n: 8,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '59a21afb-9d12-4005-8911-d38948970ae0',
    role: 'partner2',
    action: {
      kind: 'merge',
      note:
        'Two partner2 rows "Pablo Mencia de Leon" / "Pablo Mencia De Leon" ' +
        '(casing variant), same phone; keep oldest.',
    },
  },
  {
    n: 9,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '7b58869b-d099-4668-929a-4af670d19a4a',
    role: 'partner2',
    action: {
      kind: 'merge',
      survivorIdPrefix: 'd158ceb7', // the row WITH a phone
      note: 'Two partner2 rows both "Sarah Olkowski"; keep the one carrying a phone.',
    },
  },
  {
    n: 10,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: 'b3f9c081-cffa-4b0b-9233-6696e35b6104',
    role: 'partner2',
    action: {
      kind: 'merge',
      survivorIdPrefix: 'c11dc5bd', // the row WITH a phone
      note: 'Two partner2 rows both "Madison Bryant"; keep the one carrying a phone.',
    },
  },
  {
    n: 11,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: 'f788ac3d-2c57-4e3c-9a41-02b1824be9d4',
    role: 'partner2',
    action: {
      kind: 'merge',
      survivorIdPrefix: '61e5af85', // clean single-person row "Prem Minchu"
      note:
        'partner2 rows: "Prem Minchu" (clean) and "Shivani Gaur and Prem Minchu" ' +
        '(a couple-string stub — partner1 is "Shivani Gaur"). The stub is the ' +
        'same human as partner2 Prem Minchu mis-captured as a couple string; ' +
        'merge the stub into the clean "Prem Minchu" row.',
    },
  },
  {
    n: 12,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '1b2084eb-078e-4a9b-88b8-bce2439feefb',
    role: 'partner2',
    action: {
      kind: 'merge',
      note: 'Two partner2 rows both "Zac Hall", no contact on either; keep oldest.',
    },
  },
  {
    n: 13,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '529665e0-9f99-4f10-a936-a2b66bc46bf9',
    role: 'partner2',
    action: {
      kind: 'merge',
      survivorIdPrefix: '48043529', // the row WITH a phone
      note: 'Two partner2 rows both "Elias Hageman"; keep the one carrying a phone.',
    },
  },
  {
    n: 14,
    venueId: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
    weddingId: '01c62326-fcea-4f8f-990b-788065cdcc23',
    role: 'partner2',
    action: {
      kind: 'merge',
      note: 'Two partner2 rows both "Ryan Wagner", no contact on either; keep oldest.',
    },
  },
  {
    n: 15,
    venueId: '22222222-2222-2222-2222-222222222201',
    weddingId: 'ab000000-0000-0000-0000-000000000006',
    role: 'partner1',
    action: {
      kind: 'merge',
      survivorIdPrefix: 'eeeeeeee-0000-0000-0000-00000000a001', // "Sophie Whitfield"
      note:
        'DEMO venue. Two partner1 rows: "Sophie Whitfield" ' +
        '(sophie.whitfield@gmail.com) and "Sophie M Whitfield" ' +
        '(sophiewhitfield@gmail.com) — same human, name + email variant. ' +
        'partner2 is "Ben Taylor" (a distinct person, untouched). Merge the ' +
        'two Sophie rows; keep the earliest-created canonical "Sophie Whitfield".',
    },
  },
]

interface PersonRow {
  id: string
  venue_id: string
  wedding_id: string | null
  role: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  merged_into_id: string | null
  created_at: string
  external_ids: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Survivor selection for a TRUE DUPLICATE merge.
// Most-complete identity wins: real email > phone > name-only. Tie-break by
// oldest created_at. An explicit survivorIdPrefix overrides the heuristic.
// ---------------------------------------------------------------------------
function completenessScore(p: PersonRow): number {
  let s = 0
  if (p.email && p.email.trim()) s += 4
  if (p.phone && p.phone.trim()) s += 2
  if ((p.first_name && p.first_name.trim()) || (p.last_name && p.last_name.trim())) s += 1
  return s
}

function pickSurvivor(rows: PersonRow[], survivorIdPrefix?: string): PersonRow {
  if (survivorIdPrefix) {
    const hit = rows.find((r) => r.id.startsWith(survivorIdPrefix))
    if (hit) return hit
    throw new Error(`survivorIdPrefix "${survivorIdPrefix}" matched no live row`)
  }
  const sorted = [...rows].sort((a, b) => {
    const cs = completenessScore(b) - completenessScore(a)
    if (cs !== 0) return cs
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  })
  return sorted[0]
}

// ---------------------------------------------------------------------------
// Replicated softTombstonePerson cascade — see header for why it is replicated
// rather than imported. Single-wedding only (all 15 groups are single-wedding),
// so the cross-wedding reassignment branch of the canonical cascade is omitted.
// ---------------------------------------------------------------------------
async function softTombstone(
  sb: SupabaseClient,
  venueId: string,
  survivor: PersonRow,
  loser: PersonRow,
  reason: string,
  apply: boolean,
): Promise<{ interactions: number; contacts: number; tangential_signals: number }> {
  if (survivor.id === loser.id) throw new Error('softTombstone: survivor == loser')

  // Count children that will be reassigned (for log + audit snapshot).
  const [{ count: icBefore }, { count: ccBefore }, { count: tsBefore }] = await Promise.all([
    sb.from('interactions').select('id', { count: 'exact', head: true }).eq('person_id', loser.id),
    sb.from('contacts').select('id', { count: 'exact', head: true }).eq('person_id', loser.id),
    sb
      .from('tangential_signals')
      .select('id', { count: 'exact', head: true })
      .eq('matched_person_id', loser.id),
  ])
  const counts = {
    interactions: icBefore ?? 0,
    contacts: ccBefore ?? 0,
    tangential_signals: tsBefore ?? 0,
  }

  if (!apply) return counts

  // 1. Reassign children loser -> survivor.
  await sb
    .from('interactions')
    .update({ person_id: survivor.id })
    .eq('person_id', loser.id)
    .eq('venue_id', venueId)
  await sb.from('contacts').update({ person_id: survivor.id }).eq('person_id', loser.id)
  await sb
    .from('tangential_signals')
    .update({ matched_person_id: survivor.id })
    .eq('matched_person_id', loser.id)
    .eq('venue_id', venueId)

  // 2. Backfill survivor null fields from loser; union external_ids.
  const updates: Record<string, unknown> = {}
  for (const k of ['email', 'phone', 'first_name', 'last_name'] as const) {
    if (!survivor[k] && loser[k]) updates[k] = loser[k]
  }
  const survExt = survivor.external_ids ?? {}
  const loserExt = loser.external_ids ?? {}
  const unionExt = { ...loserExt, ...survExt }
  if (Object.keys(unionExt).length > Object.keys(survExt).length) updates.external_ids = unionExt
  if (Object.keys(updates).length > 0) {
    await sb.from('people').update(updates).eq('id', survivor.id)
  }

  // 3. Audit row — same shape softTombstonePerson writes.
  //    NOTE: person_merges.merged_by is a uuid FK to user_profiles(id). A
  //    system-run merge has no user, so merged_by MUST be null. The system
  //    provenance marker lives in `signals` (jsonb) instead — type
  //    'soft_tombstone', detail carries the reason 'partner_role_dup_gN'.
  //    The insert error is checked so a schema mismatch can never fail
  //    silently (it did once: passing a string into the uuid column aborted
  //    the whole insert without surfacing).
  const { error: auditErr } = await sb.from('person_merges').insert({
    venue_id: venueId,
    kept_person_id: survivor.id,
    merged_person_id: loser.id,
    signals: [
      { type: 'soft_tombstone', detail: reason, weight: 1 },
      { type: 'system_actor', detail: 'resolve-partner-dups', weight: 0 },
    ],
    tier: 'high',
    confidence_score: 100,
    snapshot: { person: loser as unknown as Record<string, unknown>, soft_tombstone: true, reason },
    merged_by: null,
  })
  if (auditErr) {
    throw new Error(`person_merges audit insert failed for loser ${loser.id}: ${auditErr.message}`)
  }

  // 4. The tombstone — set merged_into_id (idempotent guard: only if still null).
  await sb
    .from('people')
    .update({ merged_into_id: survivor.id })
    .eq('id', loser.id)
    .is('merged_into_id', null)

  return counts
}

function nameOf(p: PersonRow): string {
  return `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || '(no name)'
}

async function main() {
  const url = process.env.BRANCH_URL
  const key = process.env.BRANCH_KEY
  if (!url || !key) {
    console.error('FATAL: set BRANCH_URL and BRANCH_KEY env vars (service_role key).')
    process.exit(1)
  }
  const apply = process.argv.includes('--apply')
  const sb = createClient(url, key, { auth: { persistSession: false } })

  console.log('='.repeat(78))
  console.log(`resolve-partner-dups — ${apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`)
  console.log(`target: ${url}`)
  console.log('='.repeat(78))

  let resolved = 0
  let skipped = 0
  let review = 0
  const summary: string[] = []

  for (const g of GROUPS) {
    console.log(`\n--- GROUP ${g.n} | venue=${g.venueId.slice(0, 8)} wedding=${g.weddingId.slice(0, 8)} targetRole=${g.role} ---`)

    // Pull every live (non-tombstoned) person on this wedding for full context.
    const { data: allRows, error } = await sb
      .from('people')
      .select(
        'id, venue_id, wedding_id, role, first_name, last_name, email, phone, merged_into_id, created_at, external_ids',
      )
      .eq('venue_id', g.venueId)
      .eq('wedding_id', g.weddingId)
      .order('created_at')
    if (error) {
      console.log(`  ERROR querying group: ${error.message} — left for review.`)
      review++
      summary.push(`G${g.n}: ERROR — ${error.message}`)
      continue
    }
    const live = (allRows ?? []).filter((r) => !r.merged_into_id) as PersonRow[]
    for (const p of live) {
      console.log(
        `  BEFORE [${p.role}] id=${p.id.slice(0, 8)} name="${nameOf(p)}" email=${p.email ?? '-'} phone=${p.phone ?? '-'} created=${p.created_at}`,
      )
    }
    const targetRoleRows = live.filter((r) => r.role === g.role)
    const tombstoned = (allRows ?? []).filter((r) => r.merged_into_id) as PersonRow[]

    // Idempotency: already resolved?
    if (targetRoleRows.length <= 1) {
      // Audit-trail self-heal: a `merge` group that resolved on a prior run
      // BUT whose person_merges audit row failed to write (the historic
      // uuid-typed merged_by bug) gets its audit row backfilled here. The
      // data mutation is already correct; only the provenance row is missing.
      let backfilled = 0
      if (g.action.kind === 'merge' && apply) {
        for (const loser of tombstoned) {
          if (loser.role !== g.role) continue
          const survivorId = loser.merged_into_id as string
          const { count: existing } = await sb
            .from('person_merges')
            .select('id', { count: 'exact', head: true })
            .eq('merged_person_id', loser.id)
            .eq('kept_person_id', survivorId)
          if ((existing ?? 0) > 0) continue
          const { error: bfErr } = await sb.from('person_merges').insert({
            venue_id: g.venueId,
            kept_person_id: survivorId,
            merged_person_id: loser.id,
            signals: [
              { type: 'soft_tombstone', detail: `partner_role_dup_g${g.n}`, weight: 1 },
              { type: 'system_actor', detail: 'resolve-partner-dups:audit-backfill', weight: 0 },
            ],
            tier: 'high',
            confidence_score: 100,
            snapshot: {
              person: loser as unknown as Record<string, unknown>,
              soft_tombstone: true,
              reason: `partner_role_dup_g${g.n}`,
              audit_backfill: true,
            },
            merged_by: null,
          })
          if (bfErr) throw new Error(`audit backfill insert failed for ${loser.id}: ${bfErr.message}`)
          backfilled++
          console.log(`  AUDIT-BACKFILL — wrote missing person_merges row for tombstoned ${loser.id.slice(0, 8)} "${nameOf(loser)}"`)
        }
      }
      console.log(`  SKIP — group already satisfies one-per-role (${targetRoleRows.length} live ${g.role}).`)
      skipped++
      summary.push(
        `G${g.n}: SKIP (already resolved — ${targetRoleRows.length} live ${g.role})` +
          (backfilled > 0 ? ` [+${backfilled} audit row backfilled]` : ''),
      )
      continue
    }

    if (g.action.kind === 'merge') {
      const survivor = pickSurvivor(targetRoleRows, g.action.survivorIdPrefix)
      const losers = targetRoleRows.filter((r) => r.id !== survivor.id)
      console.log(`  CLASSIFY: TRUE DUPLICATE. ${g.action.note}`)
      console.log(`  ACTION: keep survivor id=${survivor.id.slice(0, 8)} "${nameOf(survivor)}"`)
      for (const loser of losers) {
        const counts = await softTombstone(
          sb,
          g.venueId,
          survivor,
          loser,
          `partner_role_dup_g${g.n}`,
          apply,
        )
        console.log(
          `    ${apply ? 'TOMBSTONE' : 'WOULD TOMBSTONE'} loser id=${loser.id.slice(0, 8)} "${nameOf(loser)}" ` +
            `-> survivor ${survivor.id.slice(0, 8)} | reassign interactions=${counts.interactions} contacts=${counts.contacts} tangential_signals=${counts.tangential_signals}`,
        )
      }
      resolved++
      summary.push(
        `G${g.n}: MERGE — kept "${nameOf(survivor)}" ${survivor.id.slice(0, 8)}, tombstoned ${losers.length} dup(s)`,
      )
    } else if (g.action.kind === 'detach') {
      // detach — a distinct human who does not belong to this couple at all.
      const detachId = g.action.detachIdPrefix
      const target = targetRoleRows.find((r) => r.id.startsWith(detachId))
      console.log(`  CLASSIFY: DISTINCT — NOT THIS COUPLE. ${g.action.note}`)
      if (!target) {
        console.log(
          `  REVIEW — detachIdPrefix "${detachId}" matched no live ${g.role} row. Left for operator.`,
        )
        review++
        summary.push(`G${g.n}: REVIEW — detachIdPrefix unmatched`)
        continue
      }
      // Verify: detaching this row must leave exactly one live row in the
      // queried role (otherwise detach alone does not resolve the group).
      const remainingInRole = targetRoleRows.filter((r) => r.id !== target.id).length
      if (remainingInRole !== 1) {
        console.log(
          `  REVIEW — detaching "${nameOf(target)}" would leave ${remainingInRole} live ${g.role} ` +
            `(expected exactly 1). Group not cleanly resolvable by detach alone. Left for operator.`,
        )
        review++
        summary.push(`G${g.n}: REVIEW — detach leaves ${remainingInRole} live ${g.role}`)
        continue
      }
      console.log(
        `  ACTION: detach id=${target.id.slice(0, 8)} "${nameOf(target)}" from wedding (wedding_id -> NULL)`,
      )
      if (apply) {
        await sb
          .from('people')
          .update({ wedding_id: null })
          .eq('id', target.id)
          .eq('venue_id', g.venueId)
          .eq('wedding_id', g.weddingId) // idempotent guard
      }
      console.log(
        `    ${apply ? 'DETACHED' : 'WOULD DETACH'} id=${target.id.slice(0, 8)} "${nameOf(target)}" — survives as orphan person`,
      )
      resolved++
      summary.push(`G${g.n}: DETACH — removed "${nameOf(target)}" from wedding (not part of this couple)`)
    } else {
      // rerole — distinct mis-roled humans. The if-chain guarantees the
      // rerole variant; capture it into a const so the narrowing survives
      // the function calls below (property-access narrowing is reset by calls).
      if (g.action.kind !== 'rerole') continue
      const action = g.action
      const keeper = targetRoleRows.find((r) => r.id.startsWith(action.keepRoleIdPrefix))
      if (!keeper) {
        console.log(
          `  REVIEW — keepRoleIdPrefix "${action.keepRoleIdPrefix}" matched no live ${g.role} row. Left for operator.`,
        )
        review++
        summary.push(`G${g.n}: REVIEW — keepRoleIdPrefix unmatched`)
        continue
      }
      const flippers = targetRoleRows.filter((r) => r.id !== keeper.id)
      // A re-role into the opposite role must not collide with an existing row
      // already holding that role — otherwise we just move the duplication.
      const oppositeRole = action.flipToRole
      const existingOpposite = live.filter((r) => r.role === oppositeRole)
      console.log(`  CLASSIFY: DISTINCT MIS-ROLED. ${action.note}`)
      if (existingOpposite.length > 0 && flippers.length > 0) {
        console.log(
          `  REVIEW — wedding already has ${existingOpposite.length} live ${oppositeRole} ` +
            `("${existingOpposite.map(nameOf).join('", "')}"); flipping ${flippers.length} row(s) into ${oppositeRole} ` +
            `would create a NEW duplicate. Left for operator.`,
        )
        review++
        summary.push(`G${g.n}: REVIEW — reroll target role ${oppositeRole} already occupied`)
        continue
      }
      console.log(
        `  ACTION: keep id=${keeper.id.slice(0, 8)} "${nameOf(keeper)}" on ${g.role}; ` +
          `flip ${flippers.map((f) => `${f.id.slice(0, 8)} "${nameOf(f)}"`).join(', ')} -> ${oppositeRole}`,
      )
      for (const f of flippers) {
        if (apply) {
          await sb.from('people').update({ role: oppositeRole }).eq('id', f.id).eq('venue_id', g.venueId)
        }
        console.log(`    ${apply ? 'RE-ROLED' : 'WOULD RE-ROLE'} id=${f.id.slice(0, 8)} "${nameOf(f)}" -> ${oppositeRole}`)
      }
      resolved++
      summary.push(
        `G${g.n}: RE-ROLE — kept "${nameOf(keeper)}" on ${g.role}, flipped ${flippers.length} to ${oppositeRole}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // POST-STATE verification — re-query all 15 groups.
  // -------------------------------------------------------------------------
  console.log(`\n${'='.repeat(78)}`)
  console.log('POST-STATE VERIFICATION')
  console.log('='.repeat(78))
  let allOk = true
  for (const g of GROUPS) {
    const { data: rows } = await sb
      .from('people')
      .select('id, role, first_name, last_name, merged_into_id')
      .eq('venue_id', g.venueId)
      .eq('wedding_id', g.weddingId)
    const live = (rows ?? []).filter((r) => !r.merged_into_id)
    const liveP1 = live.filter((r) => r.role === 'partner1').length
    const liveP2 = live.filter((r) => r.role === 'partner2').length
    const targetCount = g.role === 'partner1' ? liveP1 : liveP2
    const ok = liveP1 <= 1 && liveP2 <= 1
    if (!ok) allOk = false
    console.log(
      `  GROUP ${String(g.n).padStart(2)} | live partner1=${liveP1} partner2=${liveP2} | targetRole(${g.role})=${targetCount} | ${ok ? 'OK' : 'STILL VIOLATES'}`,
    )
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log('SUMMARY')
  console.log('='.repeat(78))
  for (const s of summary) console.log('  ' + s)
  console.log(
    `\n  groups resolved=${resolved}  skipped(already-clean)=${skipped}  left-for-review=${review}  total=${GROUPS.length}`,
  )
  console.log(
    `  one-per-role invariant across all 15 groups: ${allOk ? 'SATISFIED — migration 367 will apply' : 'NOT YET SATISFIED'}`,
  )
  if (!apply) {
    console.log('\n  DRY-RUN — no rows were written. Re-run with --apply to commit.')
  }
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
