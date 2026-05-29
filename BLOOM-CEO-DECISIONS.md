# Bloom House — CEO Decision Sheet

**Date:** 2026-05-28 · For: Isadora (CEO) · From: Eng Lead
**Context:** `BLOOM-CONSOLIDATION-GAP-REGISTER.md` (the audit), `FIX-PLAN-GOVERNANCE-AND-CANONICAL.md` v2, `CANONICAL-RECONCILIATION-SPECS.md`. You said you're happy to wipe + re-onboard. That instinct is right — and it changes the recommended path. Read D-5 first; it reframes everything else.

---

## The headline (read this first)

**Wiping is the right move — but it's only worth doing ONCE, and only after two things are true: (1) `linkSignal` is the SOLE identity writer for ingestion, and (2) the reimport pulls from ORIGINAL sources (Gmail API + the HoneyBook/Calendly/Knot CSV exports), NOT from the `interactions` mirror.** Wipe without those and you refill the exact same mess through the exact same broken pipes. Get those two true first, and the wipe produces a clean spine *by construction* — the Bloom Scratch result, on House's codebase.

That single insight collapses the blockers below into a coherent sequence.

---

## GROUP 1 — Gates that MUST be answered before any wipe

### D-1 (G3) — Is anyone actually live on bloom-house? · **REC: VERIFY NOW (don't assume)**
The entire safety of the wipe rests on "nobody's live," which today is a recollection, not a fact. This is a 5-minute query, not a judgment call. Run in Supabase SQL editor on the bloom-house project:
```sql
-- recent human logins?
select max(last_sign_in_at) as last_login, count(*) filter (where last_sign_in_at > now() - interval '30 days') as active_30d
from auth.users;
-- recent couple-portal / coordinator activity? (adjust table names to your session/audit tables)
select max(created_at) from notifications;
select max(updated_at) from weddings where updated_at > now() - interval '30 days';
```
If `active_30d = 0` and no recent portal writes → **you have full freedom to wipe.** If anything lights up, stop and tell me — the plan changes.

### D-2 (G1) — Where does the reimport read from? · **REC: re-source from ORIGIN, carry full bodies into the spine**
Today the reimport reads from `interactions`/`people` — the tables it's supposed to delete (circular), and `touchpoints.raw_payload` doesn't carry `full_body` (lossy). Fix:
- Reimport from **Gmail API** (re-auth) + the **HoneyBook / Calendly / Knot CSV exports** (the same artifacts you originally onboarded Rixey with).
- Make the ingestion writer put `full_body` into `touchpoints.raw_payload` so the spine is self-sufficient.
- `interactions` then becomes a *rebuildable projection*, safe to drop.
**This is the keystone.** It breaks the circularity, prevents data loss, and is precisely what makes a clean re-onboard real. Cost: Gmail re-auth + having the CSVs on hand (you do).

### D-3 (G2) — What happens to portal/event data (budget, timeline, seating…)? · **REC: measure, then most likely wipe it too**
~40 "event" tables key on `weddings.id`. A fresh re-onboard gives weddings NEW ids → those tables orphan. Two ways out:
- **(a)** Mint weddings with a **deterministic id from the HoneyBook project id**, so the reimport reproduces the same id and event data survives. (More engineering.)
- **(b)** Since bloom-house is pre-launch (pending D-1), that event data is probably seed/empty — **wipe it too and re-derive.** (Simpler, cleaner.)
**Rec: run one count first** — `select count(*) from budget_items; …timeline; …seating;` etc. If it's trivial/seed → option (b), wipe it. If there's real hand-entered planning data worth keeping → option (a), deterministic ids. Given pre-launch, I expect (b).

### D-4 (G4) — Dual-write failure handling · **REC: mostly dissolved by D-5; don't build the elaborate version**
This blocker only bites if you keep the long dual-write window (PHASED v2). If you take the cutover (D-5), the window nearly disappears and G4 is moot. For any residual: wrap the legacy+spine write in one transaction and **throw** (don't swallow) on spine failure. Don't invest in reconciliation machinery for a window you're about to delete.

---

## GROUP 2 — The strategic fork (the big one)

### D-5 — Incremental dual-write (PHASED v2) vs. spine-first cutover · **REC: spine-first cutover**

| | **Option 1: PHASED v2 (as written)** | **Option 2: Spine-first cutover (RECOMMENDED)** |
|---|---|---|
| Phase 1 | Carefully dual-write all ~138 writers in lockstep, 4–6 wks | Route the **handful of ingestion entry points** (5 adapters + pipeline) through `linkSignal`; **turn OFF** legacy-identity writes + repair crons. ~1–2 wks |
| Wipe | After full writer unification | After single-writer + re-source-from-origin (D-2) |
| Reimport | Through the unified writer | Through `linkSignal` only, from origin → **provably clean spine** |
| Readers | Limp on legacy for months, migrate limb-by-limb | Migrate right after the clean spine exists (Agent → Sage → Intel → Portal) |
| Clean spine in | ~2–3 months | **~2–3 weeks** |
| Risk | Long fragile dual-write; messy writers alive for months | Readers must migrate promptly (can't limp on empty legacy tables) |

Your willingness to wipe is exactly what makes Option 2 viable. It doesn't skip reader migration — that work exists either way — it just gets you a **trustworthy spine first**, then migrates readers on solid ground instead of during a fragile dual-write. The honest tradeoff: reader migration becomes *urgent* (no months of limping on legacy reads). For a pre-launch product, that's the right trade. **This is the Bloom Scratch outcome — clean spine by construction — achieved on House without throwing away the surfaces.**

---

## GROUP 3 — Doctrine ratifications (cheap, do this week)

### D-6 — Ratify Canonical v1.0 as supreme doctrine · **REC: YES**
Above ARCHITECTURE-DECISIONS / PLAYBOOK / IDENTITY-FIRST. One sign-off; unblocks A.1–A.5.

### D-7 — Decay window default (canonical says 90–120d) · **REC: 120 days**
Conservative end → fewer couples wrongly ghosted. Tunable down later per real data. (Replaces today's 180.)

### D-8 — Point-Zero + direction discipline = real migrations · **REC: approve the small migrations in Phase 0**
Draft A's D4/D5 need columns that don't exist: `couples.point_zero_at`, `touchpoints.zero_phase`/`direction`, and identifier reliability. These are small, additive migrations. Approve them so the golden cases (GC-8/GC-9) can go from `pending` to live.

---

## GROUP 4 — The three v1.0 "unresolved" items (§6)

### D-9 — Staffing section (coordinator availability vs staffing records) · **REC: park until Phase 3.4 (Portal)**
Not on the spine's critical path; decide when the Portal limb migrates.

### D-10 — HoneyBook absorption trajectory · **REC: park (post-consolidation)**
It's a roadmap/product call, not a consolidation blocker. Revisit after the spine is clean.

### D-11 — Knot/WeddingWire partnership data model · **REC: park**
Same — a future partnership question, not load-bearing for the rebuild. The "Knot relay = medium-confidence" rule (GC-7) already governs the data handling in the meantime.

---

## GROUP 5 — Operational (no decision, just do)

### D-12 — Wire the golden harness to a TEST-BRANCH DB
Point `.env.local` (or `.env.test`) at the `pre-tier-8` Supabase branch (`jvtnfnkgwvvfwixqivwv`) — **never** prod (`jsxxgwprxuqgcauzlxcb`; the harness refuses it). Seed a `GOLDEN_TEST_VENUE`. Then `npm run test:golden` runs GC-1…GC-9 against real `linkSignal` and tells you which already pass and which are the worklist.

---

## The sequence if you say yes to the recommendations

1. **D-1**: run the live-traffic query (today). → confirms freedom to wipe.
2. **D-6/D-7/D-8**: ratify v1.0, set decay=120, approve the 3 small migrations (this week, paper + tiny SQL).
3. **D-2**: make `linkSignal` the sole ingestion writer + carry full bodies + re-source plan from origin. (~1–2 wks)
4. **D-3**: count event-data; wipe it too unless real.
5. **Wipe + re-onboard from origin through `linkSignal`** → clean spine.
6. **Golden cases must go green** on the clean spine (the proof). Ratchets stay green/falling throughout.
7. **Migrate readers** Agent → Sage → Intel → Portal, each behind its golden + battery subset.
8. Delete the graveyard; ratchet counters hit their targets (0 dup modules, 0 hand-list, crons down).

The wipe is the right instinct. The recommendations above are how to make it the *last* wipe instead of another lap.
