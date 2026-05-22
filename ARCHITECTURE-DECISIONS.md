# Architecture Decisions — the three that gate every plan

**Date:** 2026-05-22
**Why this exists:** every consolidation plan so far (25-day, phased) silently assumed past three architectural questions. A kill list or a phased plan cannot be frozen until these are answered, because what gets kept / deleted / re-keyed / wiped is a *consequence* of the answers. This memo states each question, the code-grounded facts, the options with tradeoffs, and a recommendation. The operator decides; then a plan becomes mechanical.

**Anchors:** `CONSOLIDATION-AUDIT.md` (Day 1) · the anatomical pass (2026-05-22) · verified against `supabase/migrations/`.

**Dependency between the three:** they are not independent. **D3 gates D2** (you cannot cleanly wipe-and-reimport until the write path is unified). **D1 shapes D2's target** (what the reimport writes depends on the FK strategy). Decision order is therefore **D3 → D1 → D2**, even though they are numbered 1-2-3 by topic.

---

## Decision 1 — the `wedding_id` FK web → RESOLVED as the two-entity model

> **Resolved 2026-05-22** by comparing to `rixey-portal` (the live single-venue
> couple portal the bloom-house portal is ported from and is becoming).
> rixey-portal keys 100% of its planning tables on `wedding_id REFERENCES
> weddings(id)`. It is a *wedding*-planning portal built around `weddings` as
> the central entity. That reveals the framing below ("re-key vs bridge") was
> the wrong question. See "RESOLUTION" at the end of this section.

**The original question:** the spine is keyed on `couple_id`; the legacy world is keyed on `wedding_id`. What happens to the tables keyed on `wedding_id`?

### Verified facts

- **~90 tables carry a `wedding_id` column** (43 migration files; 96 `wedding_id uuid` column declarations). Not the ~200 I previously claimed.
- `couples.source_wedding_id uuid REFERENCES weddings(id)` exists (migration 346) with `UNIQUE(venue_id, source_wedding_id)` — **the couple↔wedding bridge is 1:1 and clean.**
- Of 1,953 Rixey couples, ~431 map to a wedding via `source_wedding_id`; ~1,522 are ghost couples (emailed, never booked — no wedding, correctly).
- The ~90 wedding-keyed tables fall into three groups:
  - **Identity/pipeline core (~8-12 tables):** `interactions`, `drafts`, `attribution_events`, `wedding_touchpoints`, `engagement_events`, `lead_score_history`, name/identity evidence tables. This is where the dual-state pain actually lives.
  - **Portal/couple-feature tables (~70):** `budget`, `contracts`, `guest_list`, `seating_*`, `timeline`, `checklist_items`, `bar_*`, `vendor_*`, etc. Couple-portal data. Only ever relevant to a **booked** couple — and every booked couple has a `source_wedding_id`.
  - **Intel/job tables (~10):** mostly venue-keyed; a few wedding-keyed.

### Options

| Option | What | Cost | Risk |
|---|---|---|---|
| **1A — Re-key everything** | Migrate all ~90 tables from `wedding_id` to `couple_id` | Months. Every FK, query, insert across the codebase | High — touches everything at once |
| **1B — Permanent bridge** | Keep all ~90 wedding-keyed; readers traverse `couple → source_wedding_id → wedding → satellite`. `weddings` never dies | Low | Doctrine's "no legacy table" becomes permanently false; every couple-scoped read pays a join |
| **1C — Hybrid** | Re-key ONLY the ~8-12 identity/pipeline-core tables onto the spine (`couple_id` / `touchpoints`). Leave the ~70 portal-feature tables wedding-keyed behind the bridge. `weddings` shrinks to a thin booked-couple anchor | Weeks, scoped | Low — the heavy migration is confined to the dual-state core |

### Recommendation (superseded — see RESOLUTION): ~~1C (hybrid)~~

---

## RESOLUTION — the two-entity model (2026-05-22)

The `rixey-portal` comparison shows the real answer is not "re-key vs bridge." There are **two legitimate entities**, and the doctrine's "couple is the unit, everything on the spine, no legacy table" conflated them:

- **`couples` = the IDENTITY.** Exists from first touchpoint, reconstructed forensically across channels. What Intel / Agent / Sage reason about. The spine.
- **`weddings` = the EVENT.** Exists once booked. Has a date, guest list, budget, seating chart, timeline. What the **Portal** plans. rixey-portal — the live product the bloom-house portal is ported from — is built entirely around this entity. `weddings` is NOT legacy; it is the event entity.

A booked couple **has** one wedding — 1:1, enforced by `couples.source_wedding_id UNIQUE`.

**The decision:**

| Table group | Holds | Keying | Action |
|---|---|---|---|
| Identity/pipeline core (~8-12: `interactions`, `attribution_events`, `wedding_touchpoints`, identity-evidence) | identity data | currently `wedding_id` — **wrong** | **Re-key to `couple_id`.** Nearly free under D2 (wiped + rebuilt couple-keyed by the unified writer). |
| Portal / event-planning (~70: `budget`, `guest_list`, `seating_*`, `timeline`, `contracts`, `bar_*`, `ceremony_order`…) | event data | `wedding_id` — **correct** | **Stays `wedding_id`-keyed.** Re-keying to `couple_id` would force event-data onto the identity entity and fight the portal being built. |
| `couples.source_wedding_id` | the link | — | The 1:1 identity↔event join. |

**Doctrine amendment:** "the spine" = `couples ⇄ weddings (1:1 for booked) + touchpoints` — two linked entities, not couples-alone. The Portal limb legitimately operates on the *event* (`weddings`); that is not a doctrine violation, it is the doctrine being precise about identity-vs-event. `weddings` survives permanently as the event entity, carrying event-planning data, carrying no identity/pipeline logic.

This makes the row-count diagnostic moot — the portal-feature tables stay wedding-keyed regardless of current row count, because they are the (growing) event-planning surface.

---

### Original options (kept for the record)

---

## Decision 2 — wipe-and-reimport, or reconcile-in-place?

**The question:** Rixey is in dual-state today — 431 weddings vs 1,953 couples. How do we get to a clean spine: reconcile the existing mess, or wipe the identity/pipeline tables and reimport from source?

### Verified facts

- **No live customer.** Susan does not exist yet. The constitution/memory confirms a real operator is not yet on the platform.
- Rixey state: 431 weddings · 796 people · 5,645 interactions · 1,953 couples · 5,096 touchpoints · 3,663 fragments · 1,677 candidate_identities.
- Source data is fully re-importable: HoneyBook CSV, Calendly export, Gmail (the backfill ran — 8,183 emails ingested; mailbox still connected).
- A wipe already happened once (2026-05-14) with a known preserve-list: voice DNA, reviews, brand assets, connections, knowledge, marketing spend, weather, calendar.
- **Critical precondition:** a reimport before the write path is unified (D3) just rebuilds the dual-state through the same 102 divergent writers.

### Options

| Option | What | Cost | Risk |
|---|---|---|---|
| **2A — Reconcile in place** | AI-assisted matching of 1,953 couples ↔ 431 weddings; dedup; tombstone ghosts | Weeks; ~1,953 judgments | Inherits every prior bug; reconciling a mess is harder than starting clean |
| **2B — Wipe + reimport** | After D3, wipe the identity/pipeline tables; reimport HoneyBook + Calendly + Gmail through the unified writer. Preserve voice DNA / reviews / brand / connections / knowledge / spend / weather / calendar | Days (Gmail backfill re-run is hours) | Near-zero — no live customer to disturb |

### Recommendation: **2B (wipe + reimport) — sequenced AFTER D3**

With no live customer, wipe-and-reimport is dramatically cheaper and produces a provably-clean spine *by construction* — the correct couples, the correct ghost set, the correct touchpoints all fall out of replaying source data through one writer. Reconcile-in-place spends weeks inheriting bugs. The **only** precondition is D3: the write path must be unified first, or the reimport reproduces the dual-state. So 2B is correct **and gated** — it cannot run until D3 is done.

---

## Decision 3 — the ordering: write-path unification first

**The question:** in what order do the pieces move? (My earlier phased plan had a dependency inversion — "Phase 1: legacy read-only" — which is not executable while every limb still reads legacy.)

### Verified facts

- 102 legacy writers; only 36 route through the cascade (Agent A). The cascade runs in **shadow mode** — it mirrors, but imperfectly, because the 102 non-cascade writers diverge it.
- 47 crons; 15 write directly, not through the cascade (Agent F). Crons are writers too.
- You cannot make `weddings` read-only while any limb still reads it — and in the starting state, all four do.

### The corrected ordering (not options — a sequence)

1. **Unify the write path.** Every writer — the 102 + the 47 crons — routes through the cascade, so legacy AND spine are written in lockstep. Legacy is **not** read-only yet; it is dual-written and kept in sync. This stops divergence. *This is Phase 1, non-negotiably first.*
2. **Wipe + reimport** (D2B) — now clean, because the reimport flows through one writer.
3. **Migrate readers limb-by-limb** onto the spine — Agent, then Sage, then Intel, then Portal. One at a time, each behind the battery.
4. **Stop writing legacy** — once no reader touches it, retire the legacy *pipeline* writes; `weddings` shrinks to the D1C anchor.
5. **Delete the graveyard** — dead surfaces, dead services, repair crons, retired tables. Last, because only now is deletion provably safe.

The one genuine sub-choice: during the dual-write window (steps 1-3), which side is source-of-truth for *reads*? Answer: **legacy stays read-truth until each limb is migrated; the cascade is write-truth throughout.** The dual-write keeps them equal, so a half-migrated state is consistent.

### Recommendation: **confirm this ordering.** Write-path unification is Phase 1. Deletion is last. Reader migration is the middle, limb-by-limb.

---

## What the resulting plan looks like once decided

If the recommendations (1C / 2B / D3-ordering) are accepted, the plan is:

- **Phase 1 — Unify the write path.** Route 102 writers + 47 crons through the cascade. Add the partner2 dedup invariant. Re-key the ~8-12 identity/pipeline-core tables onto the spine (D1C). Legacy dual-written, in sync. *~4-5 weeks.*
- **Phase 2 — Wipe + reimport** (D2B). Clean spine by construction. *~3-5 days.*
- **Phase 3 — Migrate readers, limb-by-limb, loop-confirmed.** Agent (+Loop 1) → Sage → Intel → Portal (+Loop 4). Battery subset at each. *~6-8 weeks.*
- **Phase 4 — Delete the graveyard.** 57 redundant surfaces, dead services, repair crons, retired pipeline tables. *~1 week.*

Total honest: **~3 months.** The kill list (`CONSOLIDATION-PLAN-FROZEN.md`) then becomes mechanical — deletion budget assigned to Phase 4, re-key list to Phase 1, per-limb migration to Phase 3.

## One downstream scoping question (not a co-equal decision)

Which of the five loops to wire, and in what order. The Critical Audit argued "Loop 1 (voice) is survival; the other four are nice-to-have." That is a Phase-3 scoping call, downstream of these three decisions — noted here so it is not forgotten, not folded in as a fourth architecture decision.

---

## Operator action — STATUS 2026-05-22

1. **D1 — FK web:** ✅ RESOLVED → **two-entity model** (couples=identity / weddings=event; re-key the ~8-12 identity-core tables to `couple_id`, the ~70 portal/event tables stay `wedding_id`-keyed). Resolved by the rixey-portal comparison.
2. **D2 — get-to-clean:** ✅ DECIDED → **2B wipe + reimport** (operator, 2026-05-22). Gated on D3.
3. **D3 — ordering:** ✅ CONFIRMED → write-unify first, delete last, readers limb-by-limb (operator, 2026-05-22).

**All three resolved.** Next: rewrite the phased plan against these decisions, then the kill list follows mechanically.
