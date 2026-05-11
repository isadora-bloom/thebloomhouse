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

### Finding F1 — [add your first finding here]

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
