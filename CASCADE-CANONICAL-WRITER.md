# Cascade Canonical Writer — Doctrine

**Date:** 2026-05-21 · **Plan day:** Day 2 of `CONSOLIDATION-PLAN-25-DAY-ANCHORED.md`, code-grounded correction on Day 4.
**Status:** doctrine. No code changes here — the contract Days 4-13 implement against.
**Anchors:** `CONSOLIDATION-AUDIT.md` (Day 1) · `CONSOLIDATION-PLAN-25-DAY-ANCHORED.md` § N · verified against `mint-couple.ts`, `mint-person.ts`, `touchpoints-writer.ts`, `sources/types.ts`, `identity-cascade.ts`, migration 359.

> **Correction note.** The first draft of this doc (Day 2) specified function
> signatures from the Engineering Build Plan's "as if building new" shapes
> without reading the real code. A Day-4 pressure-test against the codebase
> found the real names, signatures, and the fact that the advisory-locked
> mint RPC already exists. This version is rewritten against verified code.
> Every function name, signature, and file path below was read, not assumed.

---

## 1. The rule

**The cascade is the only path that CREATES a couple or BINDS a touchpoint.**

R1 from the Engineering Build Plan, corrected by the Day 1 audit (Agent B: 35 spine writers, most of them legitimate lifecycle/heat/decay UPDATEs). The honest rule:

- **CREATE a couple** + **BIND its touchpoint** → only through `lockAndMintCouple` → the `lock_and_mint_couple` RPC.
- **CREATE a person** (`people` row) → only through `mintPerson`.
- **CREATE a wedding** (legacy `weddings` row) → only through `mintWedding` (already the adopted chokepoint since 2026-05-12, 7 importers).
- **Lifecycle / heat / metadata UPDATEs** keep their own functions. They operate on rows that already exist; they do not route through the cascade.

R1 is a **creation boundary, not a commit boundary.** The Day 12 CI guard enforces exactly that: it blocks `INSERT`/`UPSERT` to the spine + identity tables outside the chokepoints; it does not block `UPDATE`.

---

## 2. The architecture as it actually is

Two pieces, both already built, neither fully wired.

### 2.1 The matcher — `cascadeMatch` (TypeScript, pure)

`src/lib/services/identity/identity-cascade.ts:490`

```ts
export function cascadeMatch(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeResult
```

Eight deterministic-first stages (exact_email → exact_full_name → nickname_plus_last_name → exact_phone → email_localpart_logical_name → body_cross_reference → paired_name_with_corroborator → family_name_plus_date). Pure function, no I/O — correctly TypeScript; there is no case for moving 8 stages of string logic into SQL. Two real call sites today: `matcher.ts:364`, `resolution.ts:548`.

Note the matcher's input type is `CascadeSignal` + `CascadeCandidate[]` — **not** `NormalizedSignal`. They are distinct types (§4).

### 2.2 The mint — `lock_and_mint_couple` RPC (Postgres) + `lockAndMintCouple` (TS caller)

**Migration 359 (`359_lock_and_mint_couple.sql`) already exists.** It does, in ONE transaction under ONE advisory lock:
1. `pg_advisory_xact_lock` on `hash(venue_id || ':' || lock_key)`.
2. Idempotency — touchpoint already exists for `(venue_id, channel, external_id)` → return its couple_id, mint nothing.
3. Re-check inside the lock — email/phone already resolves to a couple → attach instead of mint.
4. Otherwise mint a channel-scoped couple.
5. Attach the touchpoint (`ON CONFLICT DO NOTHING` on `UNIQUE(venue_id, channel, external_id)`).

**The Day-2 draft proposed building an `acquire_couple_lock` helper. That was wrong — the lock RPC exists and is more complete than the proposed helper.** The migration comment is explicit on why it MUST be an RPC: xact-scoped advisory locks release at COMMIT, so the lock + re-check + INSERT must share one transaction; a TS-side lock would release before the INSERT it guards. So the architecture is correctly **matcher-in-TS, mint-and-lock-in-RPC** — a deliberate hybrid, not the all-TS or all-RPC the Build Plan implied.

`src/lib/services/identity/mint-couple.ts` is the thin TS caller:

```ts
export async function lockAndMintCouple(
  supabase: SupabaseClient,
  venueId: string,
  signal: NormalizedSignal,
): Promise<MintCoupleResult>

interface MintCoupleResult {
  coupleId: string | null            // null only on pathological RPC return
  minted: boolean                    // true = new couple; false = attached to existing
  touchpointInserted: boolean        // false = idempotent rerun
  touchpointId: string | null
}
```

Plus two exported helpers in the same file: `computeLockKey(signal)` (email → phone → handle → signal-floor) and `hasSufficientIdentity(signal)` (the mint-vs-fragment gate).

**Status: built AND wired — in SHADOW MODE.** The Day-4 anatomical pass corrected the earlier "0 importers" claim (Day 1 Agent B used a too-narrow grep). `lockAndMintCouple` has two live non-test call paths: `route-by-tier.ts:161` → the `identity_first_tracer` cron, and `pipeline.ts:4109` → `linkSignal` (fire-and-forget shadow write — the forwards-linker comment: *"the legacy pipeline is unchanged above; the linker writes a parallel record"*). So the cascade RUNS, but as a shadow system parallel to the legacy `weddings`/`interactions` pipeline. **The Day 7-13 work is PROMOTION — make the shadow path the trunk and retire the legacy path — not adoption of something unwired.**

---

## 3. The creation chokepoints — real signatures

### 3.1 `lockAndMintCouple` — couple + touchpoint (new spine)

Signature in §2.2. ADOPT it: route every new-spine couple creation through it. The audit row — **open question to verify on Day 7:** migration 359's documented steps (1-5) do not mention a `couple_merge_events` write. Either the RPC writes one and the comment omits it, or the audit row is a gap to add. Verify before relying on it.

### 3.2 `mintPerson` — people rows + the partner2 dedup invariant

`src/lib/services/identity/mint-person.ts`:

```ts
export async function mintPerson(input: MintPersonInput): Promise<MintPersonResult>

interface MintPersonInput {
  venueId: string
  signals: IdentitySignals          // NOT a {weddingId, role, ...} shape
  source: PersonMintSource          // 'email_pipeline' | 'brain_dump' | 'crm_import' | ...
  reason?: string
  ownEmailsHint?: Set<string>
  supabase?: SupabaseClient
}
interface MintPersonResult {
  personId: string | null
  isNew: boolean
  matchedBy: 'email_exact' | 'email_canonical' | 'phone' | 'created_new'
           | 'self_loop_blocked' | 'resolver_error'
}
```

It already enforces three of the four invariants in its header (match-first, self-loop-blocked, name-capture chokepoint, source-label). It delegates to `resolvePersonOnly`.

**The partner2 dedup invariant is a genuine ADD — and it cannot simply "live inside mintPerson" as the Day-2 draft claimed.** `mintPerson` takes `IdentitySignals` and has no wedding context — it cannot ask "does a partner2 already exist on this wedding?" The Liam Hunt fix therefore needs one of:

- **(a)** Extend `MintPersonInput` with optional `weddingId` + `role`; when `role==='partner2'` and a partner2 already exists on `weddingId`, enrich-or-skip instead of insert. — *Preferred:* keeps the invariant in the chokepoint.
- **(b)** Do the partner2 existence check at the three `pipeline.ts` call sites (2211/2907/3062) before calling `mintPerson`. — Weaker: the invariant lives in 3 places.

Day 8 picks (a). This is the real Liam Hunt fix; the Wave-4 Sonnet phantom-partner judge stays as cleanup only.

### 3.3 Touchpoints — two different writers, do not conflate

- **New spine `touchpoints`** — written *inside* `lock_and_mint_couple` (§2.2 step 5). There is no separate new-spine touchpoint writer; the RPC owns it.
- **Legacy `wedding_touchpoints`** — written by `insertTouchpointIdempotent(supabase, row: SignalTouchpointRow)` in `touchpoints-writer.ts`. Different table, legacy era. The Day-2 draft wrongly called this "the single new-spine touchpoint writer." It is not. It stays a legacy helper until the legacy `wedding_touchpoints` table is retired (Bucket B schema work).

---

## 4. `NormalizedSignal` — the adapter contract (already exists)

`src/lib/services/identity/sources/types.ts`. Flat, snake_case. The Day-2 draft invented a nested camelCase shape — this is the real one, used as-is:

```ts
interface NormalizedSignal {
  external_id: string
  channel: string                    // 'gmail'|'calendly'|'honeybook'|'knot'|...
  action_type: string
  occurred_at: string
  signal_tier: 'highest' | 'high' | 'medium_high' | 'medium' | 'low' | 'aggregate_only'
  identity_hint: string | null       // a flat string, not an object
  primary_name?: string | null
  partner_name?: string | null
  primary_email?: string | null
  primary_phone?: string | null
  partner_email?: string | null
  partner_phone?: string | null
  wedding_date?: string | null
  session_ip?: string | null
  session_fingerprint?: string | null
  raw_payload: Record<string, unknown>
  legacy_wedding_id?: string | null
  author_class?: string | null
}
```

`signal_tier` has **six** values, not three. `identity_hint` is a flat string. There is no `bodyText`/`bodyEmails` field.

**`CascadeSignal` (the matcher's input type) is distinct from `NormalizedSignal`.** The adapter layer produces `NormalizedSignal`; something adapts it into `CascadeSignal` for `cascadeMatch`. Day 4 must read `CascadeSignal`'s definition before the stub claims a conversion exists.

**Discovery source (§ N.12)** does not need a new field on `NormalizedSignal`. The couple's "how did you find us" self-report is emitted as its own signal — `channel: 'calendly'` (or the intake channel), `action_type: 'discovery_self_report'`, the answer in `raw_payload`. It then flows through the same mint path as any other touchpoint. No type change.

---

## 5. Return shape + audit

`MintCoupleResult` (§2.2) is the return. The `correlationId` threading the Build Plan §9 wants is a separate observability concern — the logger mints it at pipeline entry; it is not part of `MintCoupleResult` today.

**Audit:** `couple_merge_events` is the identity audit log. Whether `lock_and_mint_couple` writes a row per mint is the §3.1 open question — verify Day 7.

---

## 6. Discovery source is a signal, not a verdict (§ N.12 doctrine — unchanged)

`action_type: 'discovery_self_report'` signals are touchpoints like any other.

- Always written to `discovery_sources` (verbatim, timestamped, immutable record of the claim).
- The first-touch `source` is **DERIVED** from the earliest credible touchpoint at read time (Build Plan R3), not stamped. A Knot relay email predating a booking-time "Google" self-report outranks it.
- Self-report vs earlier-touchpoint conflict → `candidate_matches` operator-review queue, never auto-resolved.

The cascade records touchpoints with honest `occurred_at`. The reader (`getSourceAttribution`, Day 3 doc) derives first-touch from the ordered set.

---

## 7. Four worked examples (real signatures)

1. **HoneyBook contract CSV row** → adapter yields `NormalizedSignal{channel:'honeybook', action_type:'contract_signed', primary_email, ...}` → `lockAndMintCouple` → RPC matches existing couple by email, attaches `contract_signed` touchpoint, `minted:false`. Partner via `mintPerson` — resolver matches the existing partner, `isNew:false`.
2. **Calendly `invitee.created`** → `NormalizedSignal{channel:'calendly', action_type:'tour_booked'}` + a sibling `NormalizedSignal{action_type:'discovery_self_report'}` carrying the `lead_source` answer → both through `lockAndMintCouple`; the discovery one also writes `discovery_sources`.
3. **brain-dump OCR row** → identity-poor `NormalizedSignal` → `hasSufficientIdentity` returns false → RPC mints nothing usable; signal lands as a fragment. Promoted later when an email signal shares the identity.
4. **Gmail inbound email** → `NormalizedSignal{channel:'gmail', ..., author_class:'couple'}`; body-extracted `partner_name` flows to `mintPerson` with `weddingId`+`role:'partner2'` → the §3.2(a) dedup invariant fires. **This is the Liam Hunt path; the invariant closes it.**

---

## 8. Migration contract — current code → this doctrine

| Current writer | Day 1 finding | Migration |
|---|---|---|
| `pipeline.ts:2211/2907/3062` partner2 inserts | Liam Hunt source | Day 8 — route through `mintPerson` w/ weddingId+role; §3.2(a) dedup kills the class |
| `lockAndMintCouple` / `lock_and_mint_couple` RPC | built, wired in SHADOW MODE (tracer cron + pipeline.ts:4109) | Days 9-11 — PROMOTE shadow→primary; retire the legacy `weddings`/`interactions` write path |
| 33 direct `couples`/`touchpoints` spine writers (Agent B) | bypass the chokepoint | Days 9-11 — creation writers → `lockAndMintCouple`; lifecycle UPDATEs stay |
| `mintPerson` | exists, grandfathered call sites migrating | Day 8 — extend input w/ weddingId+role; finish migrating the grandfathered sites |
| `mintWedding` | adopted 2026-05-12, 7 importers | no change — already the legacy weddings chokepoint |
| `capture-identifier.ts`, `cascade-on-enrichment.ts`, `binder-cron.ts` | exist, 0 importers | Days 10-12 — ADOPT / rename per § N.4 |
| `auto-merge-duplicates.ts`, `match-eligibility.ts` | exist, 0 importers | Day 6 — investigate; DELETE if superseded |
| `candidate-ai-adjudicator.ts` | serves /intel/identity-review | KEEP — coexists with `llm-judge.ts` on different schemas |

Schema collapse deferred to Bucket B (§ N.6).

---

## 9. What this document commits

- The advisory-locked mint already exists (`lock_and_mint_couple`, migration 359). **No new SQL.** The work is adoption.
- Architecture: matcher in TS (`cascadeMatch`), mint+lock in RPC (`lock_and_mint_couple`). A deliberate hybrid.
- Chokepoints by real name: `lockAndMintCouple` (couple+touchpoint), `mintPerson` (people), `mintWedding` (legacy weddings).
- The partner2 dedup invariant requires extending `MintPersonInput` with `weddingId`+`role` — it cannot live in the current signature.
- `NormalizedSignal` exists, flat snake_case, used as-is. Discovery self-report is a signal (`action_type:'discovery_self_report'`), not a new field.
- Two open items to verify Day 7: (a) does `lock_and_mint_couple` write a `couple_merge_events` audit row; (b) the `CascadeSignal`-vs-`NormalizedSignal` adaptation.
- R1 is a creation boundary; the Day 12 CI guard enforces that line.

Day 3's `INTEL-CANONICAL-API.md` is the reader counterpart — it also needs a code-grounding pass (verify `buildCoupleAttribution` + `loadCohortData` real signatures) before Days 4-5 stub against it.
