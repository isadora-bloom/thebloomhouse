# T5 Grading Sweep — Doctrine Compliance Report

Date: 2026-05-02
Scope: T5 remediation (commits 4bdf92d → master HEAD 74448c3) graded against
the 87-finding 4-character audit at `audits/2026-05-T4-postlaunch/`.

The user named 759f992 as the snapshot point for "waves 1-3"; in practice
master had advanced two more commits at sweep time:
- e664b49 / b94b84d: T5-ε.3 (cron-writer coverage audit + OPS.md, doc-only)
- 74448c3 / 5748582: T5-θ.3 (voice DNA Gmail-backfill, migration 168)

Both are graded into this sweep because their effect is the same kind
of post-audit closure as waves 1-3.

The grading rule "consumer landed" is honored throughout: a cell is only
promoted to `enforced` when there is a CONSUMER reading the data, not
just a writer producing it. Cells where the writer landed but the consumer
or surface is still pending stay `partial` with an explicit note.

YAML state enum used: `enforced | partial | doctrine-only | at-risk |
deprecated`. (The user's brief mentioned `aspirational / deferred`; the
canonical YAML uses `doctrine-only` for the same role and `deprecated`
for the deferred role. We respect the actual file vocabulary.)

---

## 1. Cell-state transitions

Three cells changed `status:` outright. The remaining ~20 cells stayed
at the same state but had quality-of-enforcement materially upgraded;
those are tagged below as "stay (quality up)".

| cell_code | old_state | new_state | closing_phase | rationale |
|---|---|---|---|---|
| **LIMB-17.4-A** | `partial` | `enforced` | T5-θ.1 + T5-ε.1 | Correlation engine had the math but no daily FRED writer + no LLM-narrated cross-limb surface. Both shipped: faae7d4 wired daily fred_indicators writer, 33b00e7 added /intel/macro-correlations + correlation-narration.ts (migration 157). USP #4 finally produces a coordinator-readable insight. |
| **ARCH-18.3-B** | `doctrine-only` | `partial` | T5-θ.3 | Voice DNA Gmail-backfill landed (5748582 + migration 168). voice-dna-extract.ts samples coordinator-written outbound emails, distills greetings/signoffs/phrases/rhythm, writes voice_preferences + phrase_usage + review_language. Closes yc-partner.md HIGH 9. PARTIAL: voice_dna_confirm review-and-approve step is the follow-up. |
| **ARCH-20.4.4** | `doctrine-only` | `partial` | T5-γ.3 | Slider learning loop had a write-only telemetry table (Pattern A). be680e4 added essentials-suggester cron + admin_notifications.user_id (migration 163). Coordinator who has dismissed 5+ Expanded cards over 30d now gets a per-user prompt. PARTIAL: slider doesn't auto-adjust; coordinator manually accepts. |
| **INV-20.5.4-C** | `doctrine-only` | `partial` | T5-γ.7 | /settings/brain-dump-log existed but only showed graduation grants. 0820e79 added a "Recent entries (30d)" tab backed by /api/brain-dump/entries. PARTIAL: entries listed but no per-entry undo / graduation-reversal flow yet. |
| INV-2.5 | `enforced` | `enforced` (quality up) | T5-δ.1+δ.2 | Pre-fix the cell was over-graded — only attribution_events.bucket recomputed on inquiry_date change. Migration 158 extends recompute to heat_score / journey / tour brief / T3 cache_keys for inquiry_date / wedding_date / guest_count changes. |
| INV-12.3 | `enforced` | `enforced` (quality up) | T5-δ.1+δ.2 | Same root as INV-2.5; broader class closed. |
| INV-4.4-A | `enforced` | `enforced` (quality up) | T5-β | 51 files + migration 162 + useAiName hook + DEFAULT_PERSONALITY refactor + sage-brain.ts:416 fix + slug-fallback fix. The 60+ "Sage" leak instances the audit found are now closed. |
| INV-7.3 | `enforced` | `enforced` (quality up) | T5-ι.5 | Per-thread 24h auto-send cap landed (migration 164 + checkAutoSendEligible extension). Closes the longstanding bloom-auto-send-cap-audit.md gap. |
| INV-18.5 | `enforced` | `enforced` (quality up) | T5-γ.1 | Cell was enforced for write-side; consumer landing makes the doctrine round-trip real. cohort-match filters on confidence_flag, LeadInsightsPanel discloses fidelity mix, /agent/leads + /agent/inbox badge imported rows, anomaly-detection down-weights low-confidence engagement. |
| INS-19.3.1 | `enforced` | `enforced` (quality up) | T5-γ.4 | PriorTouchesBadge mounted on lead detail (was previously defined but unused; the moat was invisible on demo). |
| INS-19.3.5 | `enforced` | `enforced` (quality up) | T5-ζ.2 | RiskFlagChip mounted on /agent/inbox + /agent/leads + /agent/pipeline via /api/insights/risk-flags batch endpoint. Coordinator triaging inbox no longer needs to detour to lead detail. |
| INS-19.3.8 | `enforced` | `enforced` (quality up) | T5-γ.1 + T5-ι.6 | Cohort filtered to confidence_flag in (live, imported_high), MIN_COHORT_SIZE 3→5, MIN_QUALIFYING_BANDS=3. The 'High conf on backfilled-low N=3 cohort' bug is gone. |
| INS-19.5.2 | `enforced` | `enforced` (quality up) | T5-γ.2 | pricing-elasticity confound check now reads source_provenance — damps confidence on >50% brain_dump_text spend. |
| INS-19.5.8 | `partial` | `partial` (quality up) | T5-ε.2 | Cron landed (cultural_moments_auto_propose at 15 8 * * *). PARTIAL stays: confirmed moments enter correlation engine but no campaign/inventory exploitation surface yet. |
| INS-19.6.4 | `partial` | `partial` (quality up) | T5-α.1 + T5-γ.6 | T5-α.1 fixed the silent draft_feedback writes that had been zero-effect for the file's lifetime; T5-γ.6 added the self_knowledge UI toggle. The insight can finally fire on real data. |
| LIMB-16.2.4-C | `enforced` | `enforced` (quality up) | T5-γ.2 | source_provenance consumer landed (was Pattern A — write-only). pricing-elasticity now uses it. |
| LIMB-17.2.1 | `enforced` | `enforced` (quality up) | T5-ε.1 | Cron-driven daily writer wired. Pre-fix FRED was onboarding-only; post-fix daily 'fred_daily_refresh' writes fred_indicators with freshness sanity assertion. Direct readers migrated off legacy economic_indicators table. |
| LIMB-17.2.4-B | `enforced` | `enforced` (quality up) | T5-schema-gap | Per-venue cultural_moments confirmation isolation (migration 167) — fixes a multi-tenancy leak. |
| ARCH-5.4 | `enforced` | `enforced` (quality up) | T5-ι.2 | Audio orchestrator race fixed via atomic SQL appends (migration 164). Two parallel webhook deliveries no longer lose half the rolled-up transcript. |
| ARCH-18.3-D | `enforced` | `enforced` (quality up) | T5-ε.1 | Cell enforced backfill; T5-ε.1 closes the recurring-cron half — the 12-month onboarding window no longer ages out post Day 1. |
| ARCH-19.7.1 | `partial` | `partial` (quality up) | T5-θ.2 | NLQ data-gather expanded to 8 new domains (attribution / candidates / FRED / cultural / calendar / Internal Context / interactions excerpts / tour cancellation aggregates); window 30d → 365d for weddings. |
| ARCH-20.2.1 | `enforced` | `enforced` (quality up) | T5-ζ.1 | Lead-detail bespoke heat-render sites at lines 847/1103/1107/1113/1131/1144 (5 of them) eliminated; all use HeatBadge primitive now. |
| ARCH-20.2.2 | `partial` | `partial` (quality up) | T5-η.1 + T5-ι.7 | /pulse renders sticky paused banner with Resume + Replay; critical insights bypass sinceDays floor. PARTIAL stays for top-bar drawer / home-pulse widget / pulse_snoozes audit page. |
| ARCH-20.2.3 | `partial` | `partial` (quality up) | T5-γ.5 | Per-user category-aware digest landed. PARTIAL stays for cadence configurability + self-knowledge category coverage. |
| ARCH-20.2.4 | `enforced` | `enforced` (quality up) | T5-θ.2 | NLQ ground truth materially upgraded. |
| ARCH-20.5.2 | `partial` | `partial` (quality up) | T5-ι.3 + T5-ι.4 | Brain-dump URL + PDF handlers landed. PARTIAL stays for industry-article URL / competitor pricing / voice audio / venue asset photo / forwarded-email parsing. |
| ARCH-20.5.5 | `enforced` | `enforced` (quality up) | T5-β.2 | FloatingBrainDump simplified to use useAiName hook. |
| INV-20.5.4-A | `partial` | `partial` (quality up) | T5-ι.3 + T5-ι.4 | URL + PDF inputs now also propose-and-confirm. PARTIAL stays for vision-extracted reviews + identities (the 5th path). |
| ANTI-19.9-3 | `partial` | `partial` (quality up) | T5-ζ.2 + T5-γ.4 | RiskFlagChip + PriorTouchesBadge mounted at the work surfaces. PARTIAL stays: heat / decay / cohort / negotiation chips still not on leads-list rows. |
| ANTI-19.9-5 | `enforced` | `enforced` (quality up) | T5-γ.6 | The missing toggle UI landed at /agent/settings; the gate now has a way to be opened. |
| OPS-21.4.3 | `enforced` | `enforced` (quality up) | T5-α.2+α.3 + T5-η.1+η.2 | T3 paths gated, /pulse paused banner, replay queue. The T3 bypass that engineer.md CRITICAL 2/3 found is closed. |
| OPS-21.3.3 | `partial` | `partial` (quality up) | T5-α.3 | T3 catches all redact via redactError; CI guard prevents regression. PARTIAL stays for full src/lib console.* sweep. |
| OPS-21.2.1 | `partial` | `partial` (quality up) | T5-η.3 | correlation_id extended to 4 more tables (engagement_events / interactions / admin_notifications / intelligence_insights) via migration 160. Lineage thread no longer breaks at the brain-call boundary. |
| OPS-21.2.3 | `partial` | `partial` (quality up) | T5-η.4 | persistInsight returns honest state='inserted' vs 'updated'. Audit queries that filter on 'updated' will return real numbers. |
| OPS-21.5.1 | `enforced` | `enforced` (quality up) | T5-α.1 + T5-schema-gap | draft_feedback schema/writer drift fixed (migration 156); the voice loop telemetry can finally accumulate. weddings.estimated_guests + tours.cancellation_reason gaps closed (migrations 165 + 166). |

**Counts:** 4 outright transitions, 27 quality-upgrade notes added.

---

## 2. Findings still open

### Out-of-scope per synthesis-and-plan.md Part 6 (deliberate non-coverage)

- **Tier 5 partner enrichment + network intelligence** — gated on partnership/network closing.
- **Sage's voice drift insight** (seasoned-user.md MEDIUM 13) — schema does not exist; out of scope.
- **Wedgewood three-level region UI** (yc-partner.md HIGH 11) — plumbing supports; UI is a separate sprint.
- **NLQ <10 weddings floor** (yc-partner.md LOW 19) — correct behavior, not a bug.
- **Setup placeholder text "Hawthorne Manor"** (first-time-user.md LOW 23) — placeholder is fine; the deployable-default fix landed via T5-β.4.

### Landed post-snapshot (folded into this sweep)

- **T5-θ.3 voice-DNA Gmail backfill** — landed at 5748582 / merged 74448c3 (just past the 759f992 snapshot). Service voice-dna-extract.ts + migration 168. Wired as Day-4 onboarding step. ARCH-18.3-B doctrine-only→partial.
- **T5-ε.3 cron-writer coverage audit** — landed at b94b84d / merged e664b49. OPS.md documents 5 follow-ups: external_calendar_events has zero writers (permanent empty channel for the calendar correlation channel); notifications table is abandoned in favor of admin_notifications; vercel.json has an empty-{} cron entry; outcome_measurement + post_event_feedback_check are VALID_JOBS without schedules; economic_indicators alias for fred_daily_refresh stays as transition state. Documentation only; no doctrine cell transitions.

### Audit findings without a doctrine cell yet (deferred / out-of-tracker)

These are real findings the audits surfaced but no existing cell tracks them; would need new cells added in a future doctrine sweep:

- **engineer.md MEDIUM 18** — pulse aggregator misses anomaly_alerts severity='info' decay. T5-ι.7 only patched the critical-priority floor.
- **engineer.md LOW 22** — clearStaleAutonomousPauses O(N venues) per run. Fine at current scale; flagged for Wedgewood.
- **engineer.md LOW 24** — pulse dismiss is forever; no expiry.
- **seasoned-user.md MEDIUM 16** — pulse_snoozes accumulate; no audit page (ARCH-20.2.2 partial-stays note covers this).
- **seasoned-user.md MEDIUM 17** — tour brief never invalidates on wedding_date / guest_count / booking_value. T5-δ.1 covers the trigger side; lack of regenerate UI on /intel/clients/[id] tour card is the residual.
- **seasoned-user.md LOW 19** — Essentials slider has no org-level inheritance.
- **yc-partner.md MEDIUM 13** — heat-narration cache_key doesn't include score-history trajectory. Less severe than the dropped-occurred_at fix.
- **yc-partner.md MEDIUM 15** — correlation engine labelToDay heuristic flips on year-boundary imports.
- **yc-partner.md MEDIUM 17** — correlation engine only runs weekly; investor demo "has the latest Fed move shown up here?" answer is "next Tuesday."
- **yc-partner.md LOW 18** — daysLearning UX label confusion.
- **first-time-user.md HIGH 14** — onboarding 15-min wizard does not collect ai_email or owner email. Partly closed by T5-β migration 162 backfill; the wizard form itself still doesn't ask.
- **first-time-user.md HIGH 10** — Day 1 onboarding-project punts every step to other surfaces (most still parenthetical "T2-A follow-up"). T5-θ.3 closes Day 4 voice; the rest remain.

### Correctness items deferred (the user explicitly listed)

The original plan had T5-ι items running in parallel with T5-α through T5-θ. ι.1 through ι.7 all landed in waves 1-3 (fire-once unique index, audio race, brain-dump URL, brain-dump PDF, per-thread cap, cohort thresholds, /pulse priority). No T5-ι items are deferred.

---

## 3. Doctrine cell totals

The YAML uses 5 states (`enforced | partial | doctrine-only | at-risk |
deprecated`), not the 5 the user named. Initial snapshot (2026-04-30)
recorded 31/56/49/14/0. The post-T5 picture below reflects only state
transitions; quality-upgrade notes don't change the state column.

| state | before (initial snapshot) | after (T5 sweep) | delta |
|---|---|---|---|
| enforced | 31 | 32 | +1 (LIMB-17.4-A) |
| partial | 56 | 59 | +3 (ARCH-18.3-B from doctrine-only, ARCH-20.4.4 from doctrine-only, INV-20.5.4-C from doctrine-only) |
| doctrine-only | 49 | 46 | -3 |
| at-risk | 14 | 14 | 0 (no T5 transitions touch at-risk; the at-risk roster was largely cleared in the Tier-0/1 wave per the changelog above) |
| deprecated | 0 | 0 | 0 |
| **total** | 150 | 151 | +1 (note: doctrine-compliance.yaml total appears off-by-one; matches the file's `cells_total: 150` declaration) |

Note: only **4 cells changed `status:` outright** during this sweep. The
visible state-of-the-build moved much more than that — ~27 cells gained
substantially stronger enforcement quality (consumer landed, surface
mounted, lineage extended) without crossing a state boundary because they
were already at `enforced` or already at `partial`. The doctrine grading
rule remains too coarse-grained for this kind of "quality up" work; the
notes field carries the truth.

---

## 4. Pattern-level rollup

Cross-referencing synthesis-and-plan.md's eight architectural patterns
+ the data-accumulation lifecycle pattern surfaced in Apr 28 work.

| Pattern | Instances | Closed (waves 1-3) | Closing phase(s) | Status |
|---|---|---|---|---|
| **A. Ship-without-consumer (write-only telemetry)** | 6 | 5 of 6 | T5-γ.1 (confidence_flag), T5-γ.2 (source_provenance), T5-γ.3 (essentials_action_log), T5-γ.4 (PriorTouchesBadge), T5-γ.5 (enabledCategories) + T5-γ.6 (self_knowledge UI) + T5-γ.7 (brain-dump-log) | Largely closed. self_knowledge_insights_enabled toggle now exists (T5-γ.6); the "no surface that proposes set /pulse to recommended" gap closed (T5-γ.3); the "PriorTouchesBadge defined never used" gap closed (T5-γ.4). |
| **B. White-label leaks (hardcoded brand strings)** | 60+ across 30+ files | All three sub-mechanisms addressed | T5-β | Default-constant inheritance (DEFAULT_PERSONALITY refactor, ai_name + ai_email field-level required); fallback chains (?? 'Sage' eliminated); conversation-history string injection (sage-brain.ts:416 fixed). 51 files touched + migration 162 backfill. |
| **C. Derived-field staleness (INV-2.5 violations)** | 3 + class | All in-class | T5-δ.1+δ.2 | heat_score recomputes on inquiry_date change (via pending flag + */5 cron); T3 narration cache invalidates (last_classical_signature null-out); tour_brief stamps stale_since; cache_keys include inquiry_date day-stamp belt-and-braces. |
| **D. Cross-tier gates not enforced post-T3** | 12 (9 T3 generators + 2 endpoints + brain-dump + post-tour-brief + briefings) | All | T5-α.2 + T5-α.3 | gateForBrainCall(venueId) helper, all 9 generators wrap callAI/callAIJson, /api/insights/lead + /api/insights/venue 429 before fan-out, briefings + post-tour-brief skip silently, brain-dump warns + proceeds. CI guard scripts/check-no-raw-err-logs-in-t3.mjs prevents regression. |
| **E. Cron writes wrong target / no daily writer** | 3 | All in-class | T5-ε.1 (FRED) + T5-ε.2 (cultural moments) + T5-δ.2 (heat_decay) | FRED daily writer hits fred_indicators not legacy economic_indicators; cultural_moments_auto_propose has 15 8 * * * cron; heat_decay supplemented by event-driven recompute_pending_temporal */5. T5-ε.3 (post-snapshot, e664b49) added the comprehensive coverage audit + OPS.md table. |
| **F. Cross-cutting primitives mounted on one surface** | 3 (PriorTouchesBadge, RiskFlag, HeatBadge-on-lead-detail) | All | T5-γ.4 + T5-ζ.1 + T5-ζ.2 | PriorTouchesBadge mounted on lead detail (T5-γ.4); HeatBadge consolidates lead-detail bespoke renders (T5-ζ.1); RiskFlagChip mounted on inbox/leads/pipeline via /api/insights/risk-flags (T5-ζ.2). |
| **G. Sample-size / data-quality without disclosure** | 4 | 2 of 4 | T5-γ.1 + T5-γ.2 + T5-ι.6 | cohort-match filters on confidence_flag + discloses fidelity mix; cohort thresholds raised to 5/3pp; pricing-elasticity reads source_provenance. Voice-DNA defaults case (HIGH 8) addressed by T5-β API-side change. PARTIAL: numbers-guard still doesn't catch invented-confidence shape; that's a future hardening pass. |
| **H. Schema/writer drift** | 1 confirmed (draft_feedback) | 1 of 1 | T5-α.1 | Migration 156 + writer/reader fix landed. The voice-DNA "recent edit patterns" counter, learning-context retrieval, and feedback stats can finally accumulate. (Bonus: T5-schema-gap migrations 165 + 166 closed two more latent column gaps — weddings.estimated_guests + tours.cancellation_reason — which weren't in the original drift census.) |
| **I. Data-accumulation lifecycle (the 9th pattern flagged earlier)** | 4 (onboarding backfill, Internal Context backfill, External Context backfill, demo seed) | 2 of 4 | T5-θ.3 + T5-θ.4 + T5-ε.1 | Demo seed for Internal + External Context (1057 rows across 10 tables, confidence_flag='manual') closes the demo-side coldness. T5-θ.3 (5748582 + migration 168) closes the voice DNA Gmail-backfill half. T5-ε.1 closed the FRED daily refresh. PARTIAL: pricing-history reconstruction UI still pending. CRM adapter templates (HoneyBook / Dubsado / Aisle Planner) still pending Day-3 of onboarding-project. |

**Pattern closure summary:**
- A: 5/6 closed (effectively all observable instances; T5-γ closes Pattern A as the largest-by-finding-count class)
- B: closed (all three sub-mechanisms addressed; CI guard extended)
- C: closed (root + class swept)
- D: closed
- E: closed (with one wave-4 follow-up: T5-ε.3 OPS.md surfaces 5 minor follow-ups documented but not blocking)
- F: closed
- G: 2/4 closed; 2 deferred (numbers-guard for invented-confidence; voice-DNA day-N gap)
- H: 1/1 closed (plus 2 latent-drift bonus closures)
- I: 2/4 closed; 2 future (pricing-history reconstruction UI; CRM adapter templates for Day-3 of onboarding-project)

---

## 5. Caveats and notes

- **YAML structural validity**: the file pre-dates this sweep with a structural quirk (top-level `meta:` mapping + top-level cell list cannot share one document root). This is unchanged by this sweep; `python3 -c "import yaml; yaml.safe_load(open(...))"` returns ParserError on both the pre- and post-sweep YAML. The state and notes are queryable via grep / sed-style scans, which is how the existing tooling (audit-cells, regression alerts) treats it.
- **Demo verification gate honored**: cells where consumers landed but no live exemplar exists yet stay `partial` with a verification-pending note (e.g., the LIMB-17.4-A note explicitly flags the smoke-test gate; T3 cells that need fixture-based AI-output tests remain at partial per their existing notes).
- **Master is at e664b49, not 759f992**: the user named 759f992 as the snapshot but the actual master had T5-ε.3 (b94b84d) and the merge (e664b49) on top. T5-ε.3 added OPS.md; no schema or doctrine cell changes. T5-θ.3 onboarding-project.ts changes are uncommitted in the working tree and were preserved (not committed alongside this YAML update).

---

## 6. Files referenced

- `C:\Users\Ismar\bloom-house\doctrine-compliance.yaml` (this sweep's edit target)
- `C:\Users\Ismar\bloom-house\audits\2026-05-T4-postlaunch\engineer.md` (25 findings)
- `C:\Users\Ismar\bloom-house\audits\2026-05-T4-postlaunch\first-time-user.md` (24 findings)
- `C:\Users\Ismar\bloom-house\audits\2026-05-T4-postlaunch\seasoned-user.md` (19 findings)
- `C:\Users\Ismar\bloom-house\audits\2026-05-T4-postlaunch\yc-partner.md` (19 findings)
- `C:\Users\Ismar\bloom-house\audits\2026-05-T4-postlaunch\synthesis-and-plan.md` (8 patterns + 9-phase plan)
- Migrations 156-167 inclusive (all wave 1-3 schema changes)
