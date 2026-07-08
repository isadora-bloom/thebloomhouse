# Bloom Test Findings

Running log of issues, questions, and observations from walking through Bloom while testing. Companion to `BLOOM-TEST-QUESTIONS.md` (the question side) — this is the answer side.

**How to use:** Add findings as you go. When you bring this back to a session, the assistant will group findings by pattern lens, identify which are class-of-problem vs one-off, and dispatch waves to fix the structural ones.

---

## Severity rubric

| Severity | Meaning | Fix urgency |
|---|---|---|
| **🚨 Critical** | Confident confabulation, privacy violation, data loss, paying-venue-blocking | Fix before launch (always) |
| **⚠️ Warning** | Wrong output, broken flow, dishonesty signal, missing audit trail | Fix before launch (most cases) |
| **🔍 Investigate** | Maybe wrong, maybe right — needs verification against ground truth | Surface for diagnosis |
| **💡 Insight gap** | System couldn't tell you something it should | Class-of-problem candidate |
| **🎨 UX nit** | Cosmetic, friction, naming | Fix opportunistically, don't gate launch |
| **✅ Working** | Worth recording wins too — calibration data for scoring |  |

---

## The 13 pattern lenses (for clustering when reviewed)

When the assistant reviews this doc, each finding gets tagged with which pattern it hits — that's how class-of-problem fixes emerge from a long list of individual findings.

1. **LLM-as-primitive** — heuristic where LLM judgment should be
2. **Raw source preservation** — data parsed-then-discarded
3. **Aggregate ≠ disclose** — sensitive content leaking
4. **Self-reported ≠ truth** — operator/couple input treated as authoritative
5. **Coarse classification** — 2 buckets where 3+ are needed
6. **Per-X UI when per-Y needed** — wrong unit of operator decision
7. **One-derive-all** — N config fields where one input could derive
8. **Detect-without-fix** — surface that detects but doesn't remediate
9. **Operator can't override** — inferred state with no correction path
10. **Measure-don't-assume** — pre-judged narrative instead of measurement
11. **State machine missing** — flat enum where transitions matter
12. **Disagreement is gold** — stated vs forensic gap not surfaced
13. **Audit trail missing** — operator action without history

If a finding doesn't fit any of these, mark it `Novel` — that's a new pattern worth extracting into doctrine.

---

## Per-finding template

```
### Finding F[N] — [short title]

**Date / time:** YYYY-MM-DD HH:MM
**Page / route:** e.g. /agent/leads, /intel/clients/[id], /intel/disagreements
**Severity:** 🚨 Critical / ⚠️ Warning / 🔍 Investigate / 💡 Insight gap / 🎨 UX nit / ✅ Working
**Pattern lens (assistant fills):** _to be assigned on review_
**Test battery question #:** Q[N] (if from BLOOM-TEST-QUESTIONS.md) or N/A
**Status:** Open / Investigating / Dispatched as Wave[N] / Fixed in commit [hash] / Dismissed

**What you expected:**
[short — what should have happened]

**What Bloom did:**
[short — actual behavior, paste relevant data if useful]

**Evidence / specific case:**
[Optional: wedding code RM-XXXX, specific text, screenshot reference, SQL query results]

**Your hypothesis (optional):**
[What you think is broken or missing]

**Note for the assistant:**
[Anything that would help group / triage this — "same pattern as F12?", "links to F8?"]
```

---

# Findings log

Add new findings below this line. Order doesn't matter — assistant will cluster on review.

---

### Finding F0 — Battery scorer rebuilt; the automated half of the review pass has run (2026-07-08, R2)

**Date / time:** 2026-07-08, judge `battery-judge.prompt.v1.1`
**Page / route:** benchmark harness (`scripts/run-battery.ts`)
**Severity:** meta / process
**Test battery question #:** all 43
**Status:** Open — human half still owed

The regex scorer that put 29/38 answers at ceiling regardless of truth is retired to a fallback. Scores now come from an LLM judge that reads the whole answer against verified database facts (17/43 questions carry a ground-truth probe). Two back-to-back stability runs on v1.1: avg **+1.05** and **+0.98** (was a fake +1.55 on regex), Tier-4 −3 count **1** then **0**. The judge is stable; run-to-run score diffs are either ±1 borderline calibration or the product itself being non-deterministic (see F1–F3). The `review-sheet-*.md` in `battery-results/` is the fillable operator pass — the −3s below are DB-confirmed, but the +1/+2 calibration scores still want your eyes on ground truth you know and I don't.

### Finding F1 — NLQ brain confabulates channel conversion rates (reproducible, highest confidence)

**Date / time:** 2026-07-08, both stability runs
**Page / route:** intel-brain `answerNaturalLanguageQuery` (Q26, also feeds Q32b/Q38)
**Severity:** HIGH — confident confabulation on the attribution thesis
**Pattern lens (assistant fills):** confident-black-box / contradicts-canonical
**Test battery question #:** 26 (−3 both runs, judge confidence 0.95)
**Status:** Open

**What you expected:** channel conversion figures that match the canonical attribution data (`getSourceAttribution`).

**What Bloom did:** stated "unknown" source converts at 86% (12/14) in 2026 and ~100% in 2024/2025, with specific revenue ($211,799) and per-channel inquiry counts.

**Evidence / specific case:** the verified attribution probe shows `unknown_acquisition` at 40% conversion over n=392 — a direct same-metric contradiction, not a rounding gap. Reproduced in both runs. This is the confabulation class Phase 3 reader-migration onto the canonical fns is meant to kill: the brain is narrating numbers it isn't reading from the canonical layer.

**Note for the assistant:** prime candidate for the Intel limb of R3 — wire the NLQ answer path onto `getSourceAttribution` so it can't invent conversion rates.

### Finding F2 — Product honesty is non-deterministic on false-premise + workflow questions

**Date / time:** 2026-07-08
**Page / route:** intel-brain NLQ (Q32b false-premise, Q37 weekend-tour workflow)
**Severity:** HIGH
**Test battery question #:** 32b (−3 then +2), 37 (+1 then −3)
**Status:** Open

**What Bloom did:** on the same question across two runs, once cleanly challenged the false premise / honestly hedged, and once invented specific figures (Q32b: fabricated spend + revenue) or a fake named tour attendee (Q37: "Clay Foley" / "Sadra Duda" — no such tour exists; the only tour is 2026-07-08 for couple 4f1d0f6c).

**Evidence:** the judge scored each answer correctly; the swing is the brain, not the scorer. Inventing a named individual for a tour that doesn't exist is exactly the dangerous failure Q37 was written to catch.

**Note for the assistant:** temperature / grounding issue on the NLQ path. Worth a look independent of R3.

### Finding F3 — Q12 fails deterministically on the AI fallback path

**Date / time:** 2026-07-07 evening run (fixed-ish by retry, still flaky)
**Page / route:** intel-brain NLQ (Q12, two-part YoY-with-confounders question)
**Severity:** MEDIUM
**Test battery question #:** 12
**Status:** Open

**What Bloom did:** returned "AI unavailable: Claude failed and no OpenAI fallback is configured" — likely the 30s timeout on a long two-part prompt with no `OPENAI_API_KEY` set for fallback. The v1.1 runs got a score via the brain-call retry, but the underlying fragility remains.

**Note for the assistant:** set the fallback key or check the circuit breaker threshold for long prompts.

### Finding F4 — HoneyBook ingestion may be genuinely dropping (surfaced by the new monitor)

**Date / time:** 2026-07-07, ingestion-monitor backtest
**Page / route:** `scripts/backtest-ingestion-monitor.ts`
**Severity:** MEDIUM — needs operator confirmation
**Status:** Open

**What the monitor found:** HoneyBook inbound counts 13/8/11 (Oct–Mar) → 6/2/2 (Apr–Jun), same collapse shape as the Knot regression. The new monitor flags it critical. Could be real, or a change in how HoneyBook routes mail. Wants your eyes.

---

### Finding F5 — [add your next finding here]

**Date / time:**
**Page / route:**
**Severity:**
**Pattern lens (assistant fills):**
**Test battery question #:**
**Status:** Open

**What you expected:**

**What Bloom did:**

**Evidence / specific case:**

**Your hypothesis (optional):**

**Note for the assistant:**

---

<!-- Copy the template above for each new finding. Don't worry about numbering or pattern-assignment — the assistant will reconcile when you bring this back. -->

---

# Assistant section (filled on review)

## Pattern distribution

_To be filled when assistant reviews the findings._

Findings count by pattern lens:
- Pattern 1 (LLM-as-primitive): N
- Pattern 2 (Raw source): N
- Pattern 3 (Aggregate ≠ disclose): N
- ...

## Clusters → wave dispatch plan

_To be filled when assistant reviews. Each cluster gets a proposed wave OR a one-off fix._

| Cluster | Findings | Proposed fix | Wave / commit |
|---|---|---|---|
| | | | |

## Calibration insights

_To be filled when assistant reviews. Examples of patterns to extract:_
- Tier 4 honesty scores: how often did Bloom refuse vs confabulate?
- Confidence-vs-correctness calibration delta
- Most common pattern in findings (suggests next architectural priority)
- Patterns NOT yet hit (suggests areas to test next round)

## New doctrine candidates

_If any findings are marked `Novel` (don't fit any of the 13 patterns), document the new pattern here and propose adding to memory._

---

# How to use this file in the workflow

**During testing (you):**
1. Walk through pages with `BLOOM-TEST-QUESTIONS.md` open
2. When something feels off or interesting, copy the template into a new finding section
3. Don't worry about pattern-assignment, severity calibration, or clustering — just capture what you saw
4. Optional: paste relevant data (page output, SQL result, specific wedding code) into the evidence field

**On review (assistant):**
1. Reads every finding
2. Tags each with pattern lens (or marks `Novel`)
3. Groups findings into clusters where 1 fix addresses N findings
4. Proposes waves (class-of-problem fixes) vs one-off patches
5. Surfaces calibration insights — what does the distribution of findings tell us about Bloom's actual readiness?
6. Updates the "Assistant section" at the bottom

**After review:**
- Dispatch the wave plan
- Update each finding's `Status` field
- Re-test the same questions after fixes → see if scores improve

---

# Anchor references

- `BLOOM-TEST-QUESTIONS.md` — the question side (36 questions, 11 tiers, calibration scoring)
- `PROMPT-BIAS-AUDIT.md` — Wave 21's read-only audit of LLM prompt bias
- `bloom-constitution.md` (memory) — the forensic identity reconstruction thesis
- `feedback_deep_fix_vs_bandaid.md` (memory) — class-of-problem vs symptom-level
- `feedback_measure_dont_assume.md` (memory) — neutral framing doctrine
- `feedback_self_reported_sources_not_truth.md` (memory) — disagreement is gold
- `bloom-may10-wave4-8-shipped.md` (memory) — the 16-task stack reference
