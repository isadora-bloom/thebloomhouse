# Trace: people.merged_into_id without FK reassignment

Surfaced during the F10 duplicate-merge dry-run on Crystal Fuller (RM-0480). Agent reported that her duplicate partner1 row is already soft-tombstoned via `merged_into_id`, but `mergePeople` (the canonical writer) hard-deletes rather than soft-tombstones. So whoever set that `merged_into_id` did it OUTSIDE `mergePeople`, which means FK children probably weren't reassigned.

## Writers of `people.merged_into_id`

Full grep across `src/`, `scripts/`, `supabase/`:

| Path | Behaviour |
|---|---|
| `lib/services/identity/merge-people.ts` (mergePeople) | **Does NOT write merged_into_id.** Hard-DELETEs the merged row (line 176) after reassigning all FK children. |
| `lib/services/identity/profile-to-people-sync.ts:421` (`applyPhantomTombstone`) | **Writes merged_into_id on partner2.** Does NOT reassign FK children. |
| `lib/services/identity/reconciliation.ts:684, :934` | Writes merged_into_id on **weddings** (not people). |
| `lib/services/identity/resolver.ts:1130` (`mergeWeddings`) | Writes merged_into_id on **weddings** (not people). |
| `lib/services/booked-data-recovery.ts:938` | Writes merged_into_id on **weddings**. |
| `lib/services/data-integrity/remediation/wedding-has-people.ts:365` | Writes merged_into_id on **weddings**. |
| `scripts/rixey-load/73-nnn-verify.ts:262` | Test-merge on **weddings**, immediately reverted. |

So `people.merged_into_id` has exactly **ONE writer** in current code: `applyPhantomTombstone` at `profile-to-people-sync.ts:421`.

## What applyPhantomTombstone actually does

Triggered when the Wave 4 Sonnet judge in `reconstruct.ts` decides `is_phantom_partner_relationship=true` (e.g., the LLM-extracted partner2 turns out to be a sign-off ghost of partner1, like "Brett & Brett" from "Hi from Brett"). The path:

```ts
// profile-to-people-sync.ts:418-431
} else if (partner2) {
  const { error } = await supabase
    .from('people')
    .update({ merged_into_id: partner1.id })
    .eq('id', partner2.id)
  ...
}
```

It stamps `merged_into_id` and stops. It does NOT:
- Reassign `interactions.person_id` (line 246-254 of mergePeople)
- Reassign `drafts.wedding_id` (if cross-wedding)
- Reassign `engagement_events.wedding_id`
- Reassign `contacts.person_id`
- Reassign `tangential_signals.matched_person_id`
- Backfill non-null fields from merged → partner1
- Write a `person_merges` audit row

Reason for the difference: phantom partner2 is "ghost data the LLM hallucinated" — typically the partner2 row has NO FK children because it was minted by the same reconstruct sweep that's now tombstoning it. But there are cases where it does have children:

- A pipeline.ts run earlier minted partner2 from `extracted.partnerName` (pipeline.ts:1975 — synthetic partner2 insert). Subsequent inbound emails to that hallucinated address get logged as `interactions.person_id = partner2_id`.
- An openphone SMS arrived from an unknown phone number and `tryMatchSmsByName` matched it to the phantom partner2 row by Haiku-inferred name match. That SMS now has `person_id = partner2_id`.

In those cases, the FK children orphan to a tombstoned row. Readers that filter `merged_into_id IS NULL` skip the parent, so the children become invisible. They still exist in the DB; nothing renders them.

## Crystal Fuller specifically

She has TWO **partner1** rows, both with `crystalgailfuller@gmail.com`. One is tombstoned. **`applyPhantomTombstone` only tombstones partner2** (see line 418-431). So Crystal's tombstoned partner1 came from:

(a) Direct SQL by an operator (Isadora or admin via Supabase SQL editor)
(b) A retired code path
(c) A historical role flip: the row was once partner2, got phantom-tombstoned, then later someone reassigned `role='partner1'`

Without a git-history dive on the DB schema/data, (a) is the most likely. The shape ("two partner1 rows with same email + one tombstoned") is consistent with a quick fix-up someone made by hand.

## Bug B I uncovered while tracing this

While reading the lead-detail UI to confirm Crystal Fuller's duplicate render, found that the people query at `intel/clients/[id]/page.tsx:707-710` doesn't filter `merged_into_id IS NULL`:

```ts
supabase
  .from('people')
  .select('id, role, first_name, last_name, email, phone')
  .eq('wedding_id', weddingId)
  .eq('venue_id', VENUE_ID),
```

**So tombstoned partner rows render in the Contacts section.** That's why Crystal appears twice — both her real row AND her tombstoned duplicate get rendered. This is the visible failure of `applyPhantomTombstone`-class tombstoning even when no FK reassignment is needed: the tombstone column exists but isn't consistently respected.

Filter must be added on every people-row reader in the lead-detail and intel surfaces.

## The fixes (shipping now)

### F1. `applyPhantomTombstone` must reassign FK children before tombstoning

Best option: refactor it to call `mergePeople` (which handles all reassignment + audit + the field backfill). Tradeoff: `mergePeople` hard-deletes, but the phantom partner2 was probably already empty. The `person_merges` snapshot captures the row state for undo.

Alternative if you want to preserve the row: factor out `reassignChildren` from mergePeople into a shared helper that `applyPhantomTombstone` can call before setting merged_into_id.

I'm going with the alternative — soft-tombstone is the existing semantic choice in profile-to-people-sync (the comment at line 401 says "Idempotent: tombstoned partner2 rows are filtered upstream by loadPartners"). Preserve that semantic, fix the FK gap.

### F2. Lead-detail UI must filter `merged_into_id IS NULL` on people query

One-line addition to `intel/clients/[id]/page.tsx:710`.

### F3. Audit OTHER people-query readers across the codebase

If the lead-detail UI missed this filter, other readers probably did too. Worth a sweep. NOT shipping in this round; documenting as known follow-up.

## Class-of-problem

This is the **third writer outside the chokepoint** for identity-related state. The identity audit (`IDENTITY-RESOLUTION-AUDIT-2026-05-12.md`) called out F4 (two resolveIdentity functions) and F5 (8 direct-INSERT wedding sites). This is a fourth instance of the same pattern: a writer that bypasses the canonical service does part of the work and skips part of it. The canonical service `mergePeople` knows to reassign FK children; the bypass writer (`applyPhantomTombstone`) doesn't.

The systemic fix is **make `applyPhantomTombstone` route through `mergePeople`** (or a shared FK-reassign helper). The class is identical to F5 — bypass paths that re-implement subsets of canonical logic.
