# Canonical Reconciliation Specs (Draft A)

**Date:** 2026-05-28
**Purpose:** the implementable specs for Layer A of `FIX-PLAN-GOVERNANCE-AND-CANONICAL.md` — reconcile the consolidation with *Bloom Canonical Product Definition v1.0*. These resolve gaps **G11, G13, G14** and the §3.3/§3.4 deltas. They are written to be appended to `ARCHITECTURE-DECISIONS.md` (D4–D6) and consumed by Phase 1 cascade work + the golden cases (Draft B).
**Rule:** these are *spine semantics*. They must land in Phase 1 (writer/cascade work), not after — fixing the anchor on a built spine is rework.

---

## D4 — Point-Zero is mid-funnel (reverts Tier-8)

### Decision
**Point-Zero is the first event at which a couple is known by BOTH a name AND a reachable identifier** (email / phone / messaging handle). It is *not* the booked wedding (the Tier-8 redefinition is retired) and *not* first contact.

### Data model
- `couples.point_zero_at timestamptz NULL` — set once, immutable after first set (the moment Point-Zero is established).
- `couples.point_zero_touchpoint_id uuid NULL REFERENCES touchpoints(id)` — the touchpoint that established it.
- `touchpoints.zero_phase text` ∈ `{'pre_zero','post_zero'}` — stamped at link time relative to the couple's `point_zero_at`. Touchpoints on a fragment (no couple yet) are implicitly pre-zero and re-stamped on promotion.

### Establishment rule (in the cascade, `forwards-linker` / `tracer`)
A couple's Point-Zero is established at the **earliest** touchpoint for which BOTH hold:
1. a name is present (display name or extracted partner name), AND
2. a reliability-`direct` OR `relay` identifier is attached (per the existing reliability tiers).

- Before that touchpoint: the signal lives on a **Fragment** (pre-zero, aggregate-only — never surfaced as an individual lead; Canonical §3.2/§3.4).
- At that touchpoint: the Fragment promotes to a Channel-Scoped or Resolved Person, `point_zero_at` is set, and all the fragment's prior touchpoints are re-stamped `pre_zero` and re-pinned to the couple.
- After that touchpoint: touchpoints are `post_zero`, pinned to the couple directly.

### Signal-typing consequence (attribution — Phase 3.3)
The same channel means different things on each side of zero, and attribution MUST distinguish them:
- **pre_zero Knot view** = a *discovery* signal (it contributed to acquisition).
- **post_zero Knot email** = a *reconfirmation* signal (it did not acquire; the couple was already known).
Conflating them double-credits the channel. First-touch / source-quality derivations read **pre_zero discovery signals only** for acquisition credit.

### Always-surfaced rule (Canonical §3.3)
Every couple view shows whether Point-Zero has been established. A couple with touchpoints but no `point_zero_at` renders as "pre-zero / fragment-stage," never hidden.

### Temporal coalescence (Canonical §3.3)
Fragment→Person promotion uses a **48–72h** coalescence window; match confidence decays as the window widens. This is the primary mechanism that establishes Point-Zero from clustered fragments. (Implementation reuses the existing matcher; this spec only fixes the window + the confidence-decay curve as first-class.)

### Golden cases
**GC-8** asserts: a pre-zero touch pins to the candidate/fragment and is typed `discovery`; a post-zero touch of the same channel pins to the couple and is typed `reconfirmation`; `point_zero_at` is set exactly once at the qualifying touchpoint.

---

## D5 — Decay clock: 90–120 days, couple-side inbound only, write-time direction

### Decision (resolves G11)
- The decay window is **configurable 90–120 days** (default **120**), replacing the current 180. Migration: change `couples.decay_window_days` default 180→120 and the CHECK to `BETWEEN 90 AND 120`; update the `decay.ts` fallback `?? 180` → `?? 120`.
- **Only couple-side INBOUND engagement resets the clock.** Venue outbound — sent email, auto-follow-up, Sage draft — never resets decay and never adds heat (Canonical §3.4, §5). This is a **hard invariant enforced at the write layer**, not inferred at read time.

### Direction discipline (Canonical §5)
- Every interaction/touchpoint carries a `direction` ∈ `{'inbound','outbound'}` **set at write time**. A row written without a direction is an **error condition**, not a default.
- The decay-reset path and the heat-accrual path consume `direction = 'inbound'` only. No read-time inference of direction is permitted anywhere.

### Two-heat-system debt (G11)
There are two heat models (`wedding_heat` 0.98^days; `identity/heat-score.ts` 14-day half-life). This spec does **not** pick the winner here — it mandates that whichever survives Phase 3 (a) consumes write-time `direction`, (b) excludes outbound, (c) uses the 90–120 window for the lifecycle decay axis. The collapse-to-one-heat-model is added to the Module-Deletion Budget (M2).

### Golden case
**GC-9** asserts: an outbound email on a couple does NOT change `last_progression_at`, does NOT reset decay, and adds 0 heat; a subsequent couple-side inbound DOES reset decay and accrue heat.

---

## D6 — The five identity states (state machine made canonical)

### Decision (resolves the §3.4 delta; House schema is already ~correct)
House's `couples.lifecycle_state ∈ {channel_scoped, resolved, booked, ghost, agent}` is retained and is the canonical machine, with **Fragment** as the explicit pre-couple state (it already lives in the `fragments` table). Mapping to Canonical v1.0's five states:

| Canonical state | House representation | Intelligence applies? | Decays? |
|---|---|---|---|
| **Fragment** | row in `fragments` (no couple) | No (aggregate-only) | Expires (never resurrects) |
| **Channel-Scoped Person** | `couples.lifecycle_state='channel_scoped'` | Limited | Yes (couple-side inbound) |
| **Resolved Person** | `…='resolved'` | Yes — all features | Yes (couple-side inbound) |
| **Ghost** | `…='ghost'` | Monitoring only | Dormant; revivable couple-side only |
| **Booked Person** | `…='booked'` (has `source_wedding_id`) | Full, **locked** | **Never** |
| *(Agent — separate class)* | `…='agent'` + `agent_couple_links` | n/a (acts on behalf of couples) | n/a |

### Transition invariants (enforced at the write/cascade layer)
1. **Fragment → Person** only via promotion at Point-Zero (D4). One-way. A Fragment never becomes two Persons; two Fragments never auto-merge into one Person without a deterministic anchor (Canonical §3.2; this is the two-Sarahs guard).
2. **Resolved/Channel-Scoped → Ghost** after `decay_window_days` (D5) with no couple-side inbound progression.
3. **Ghost → Resolved** (revival) only on couple-side inbound, operator-confirmable; **Fragments never resurrect** after Ghost death (Ghosts retain hashed ids + aggregate metadata).
4. **→ Booked** locks source attribution; `booked` never decays.
5. **Never spawn two Person rows for one wedding** — funnel through `mintPerson` (already enforced via migration 367; this is GC-3).

### Golden cases
- **GC-3** (partner2): minting a partner when partner2 exists → enrich-or-skip, never a third row. *(Already a cleanup; this spec ratifies it as a state invariant.)*
- **GC-4** (two Sarahs): two distinct same-name couples with non-overlapping identifiers stay **two**; auto-merge suppressed; routed to review.
- **GC-7** (Knot relay ceiling): a relay-only identity is capped at **Channel-Scoped / medium confidence** and cannot auto-merge until a `direct` identifier is observed.

---

## D-housekeeping — battery count (resolves G14)

The battery is **37 questions** (Tier 9 / Q37 = the workflow chain). Every plan doc saying "36" is stale. Action: global replace 36→37 in `CONSOLIDATION-PLAN-PHASED.md`, `CASCADE-CANONICAL-WRITER.md`, `INTEL-CANONICAL-API.md`, `CONSOLIDATION-PLAN-FROZEN.md`; add a Q37 row to the battery→phase map (it lands at **Phase 3.3**, since the chain needs the canonical Intel functions live). The Phase-4 ship gate denominator becomes 37.

---

## The five USPs → battery coverage check (resolves A.4 / Canonical §2)

Confirm the battery demonstrably exercises all five ranked USPs; add questions where missing:

| USP | Covered today? | Action |
|---|---|---|
| 1. Heat + decay | partial | add a Q asserting decay fires at 90–120d and outbound never resets (ties to GC-9) |
| 2. Source **quality** ("best couples, not most") | yes (`source-quality.ts` exceeds spec) | keep; ensure a battery Q reads conversion×spend×review-score, not just volume |
| 3. Voice DNA | yes (loop closes) | keep |
| 4. External macro layer | yes (FRED + Bonferroni) | add a Q that requires a macro correlation in the answer (the USP is invisible if never asked) |
| 5. NLQ | live works; canonical stub (G12) | gate Phase 3.3 on `askIntel` being real, not the `intel-brain` shim |

---

## Sequencing (where Draft A lands in the existing phases)

- **Phase 0:** write D4/D5/D6 into `ARCHITECTURE-DECISIONS.md`; do the 36→37 sweep; author the battery-vs-5-USP questions; build GC-3/4/7/8/9 fixtures (Draft B).
- **Phase 1:** implement D4 Point-Zero stamping + D5 write-time direction/decay-window in the cascade; the partner2 invariant (D6/GC-3) is already done.
- **Phase 3.3:** D4 signal-typing in attribution; gate on canonical `askIntel`.

These are doctrine + small schema + cascade-semantics changes — cheap on paper, expensive if discovered in code later. That is why they precede the writer migration.
