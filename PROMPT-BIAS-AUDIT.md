# Prompt Bias Audit — Wave 21

**Date:** 2026-05-11
**Auditor:** Wave 21 read-only sweep
**Anchor doctrine:** `~/.claude/projects/C--Users-Ismar/memory/feedback_measure_dont_assume.md`
**Repo commit at audit start:** `95353b3`
**Scope:** Every file under `src/config/prompts/`

## Headline

- **22 prompt files audited** (4 layered rules files + 18 LLM-callsite prompts; `task-prompts-*.ts` are four legacy task selectors).
- **Severity counts:** critical 2 · warning 6 · info 6 · clean 8.
- **Two critical findings echo the doctrine almost word-for-word.** The Wave 7A discovery-engine system prompt and the Wave 7B channel-role-classifier both **pre-impose direction** on the answer the LLM is meant to discover. The classifier prompt literally tells the model "lean validation when same-platform pre-inquiry signal is absent" — a measurement system instructed to favour one verdict.
- A broad pattern of **anchored examples** runs through ~12 prompts. Most are benign (anonymisation placeholders), but in 5 cases (`discovery-engine`, `couple-intel-derive`, `alumni-cohort`, `cohort-rollup`, `venue-thesis`) the in-prompt examples telegraph specific labels (e.g. `"Heritage-Forward Planner"`) often enough that the model is observably copying them in production output.
- Evidence-quote discipline and refusal-discipline are **mostly strong** — the forensic prompts (`identity-reconstruction`, `referral-extractor`, `inquiry-intent-judge`) all enforce verbatim quotes + mutual-exclusive refusal fields. Sensitivity gating is also strong (sensitive=true tagging at Wave 4, aggregate-only at 5B/5C/5D/14).
- Several prompts ask the LLM to author **`recommended_action_if_validated`** before any data has been seen (Pattern A loaded narrative). That's the most operationally dangerous bias because it leaks into operator-facing reallocation copy via Wave 6C and the digest narrators.

---

## Inventory

| # | File | Version constant | Tier (call-site) |
|---|------|------------------|------------------|
| 1 | `identity-reconstruction.ts` | `identity-reconstruction.prompt.v2` | sonnet (`reconstruct.ts:832`) |
| 2 | `couple-intel-derive.ts` | `couple-intel-derive.prompt.v1` | sonnet (`per-couple-derive.ts:344`) |
| 3 | `cohort-rollup.ts` | `cohort-rollup.prompt.v1` | sonnet (`cohort-rollup.ts:640`) |
| 4 | `channel-role-classifier.ts` | `channel-role-classifier.prompt.v1` | sonnet (`classify.ts:663`) |
| 5 | `external-match.ts` | `external-match.prompt.v1` | sonnet (`external-match.ts:754`) |
| 6 | `discovery-engine.ts` | `discovery-engine.prompt.v1` | sonnet (`discovery/engine.ts:757`) |
| 7 | `venue-thesis.ts` | `venue-thesis.prompt.v1` | sonnet (`onboarding/generate-thesis.ts:626`) |
| 8 | `marketing-recommendations.ts` | `marketing-recommendations.prompt.v1` | sonnet (`recommendations/generate.ts:629`) |
| 9 | `hypothesis-validator.ts` | `hypothesis-validator.prompt.v1` | sonnet (`run-validation.ts:283 + :346`) |
| 10 | `marketing-digest.ts` | `marketing-digest.prompt.v1` | sonnet (`digest-builder.ts:630`) |
| 11 | `discovery-digest.ts` | `discovery-digest.prompt.v1` | sonnet (`discovery-digest.ts:366`) |
| 12 | `referral-extractor.ts` | `referral-extractor.prompt.v1` | haiku (`referrals/extract.ts:221`) |
| 13 | `lifecycle-transition.ts` | `lifecycle-transition.prompt.v1` | haiku (`lifecycle/sweep.ts:422`) |
| 14 | `alumni-cohort.ts` | `alumni-cohort.prompt.v1` | sonnet (`alumni/generate.ts:362`) |
| 15 | `tour-prep-brief.ts` | `tour-prep-brief.prompt.v1` | sonnet (`tour/prep-brief.ts:414`) |
| 16 | `post-tour-sage.ts` | `post-tour-sage.prompt.v1` | sonnet (`tour/post-tour-sage.ts:308`) |
| 17 | `review-solicit.ts` | `review-solicit.prompt.v1` | sonnet (`reviews/solicit.ts:436`) |
| 18 | `inquiry-intent-judge.ts` | `inquiry-intent-judge.prompt.v1` | haiku (`intent-classifier.ts:705`) |
| 19 | `universal-rules.ts` | `UNIVERSAL_RULES` (no version) | n/a — layered into every Sage/agent call |
| 20 | `coordinator-rules.ts` | `COORDINATOR_RULES` (no version) | n/a — layered into coordinator narrators |
| 21 | `couple-rules.ts` | `COUPLE_RULES` (no version) | n/a — layered into couple-facing chat |
| 22 | `task-prompts-{sage,inquiry,client,intel}.ts` | (no version constants) | sonnet via personality-engine wrap |

---

## Findings (one card per prompt)

### 1. `identity-reconstruction.ts` — **CLEAN**

**Severity:** clean.
**Tier:** sonnet.

Strong forensic prompt. Every populated claim is required to carry a verbatim `evidence_quote`. Refusals are mandatory when evidence is too thin. Sensitive-theme tagging is explicit (medical / grief / financial_stress / family_conflict / mental_health → `sensitive:true`). Phantom-partner detection is rule-driven not assumption-driven. The validator enforces shape.

**Patterns:**
- Pattern A: not detected.
- Pattern D (evidence-quote): enforced.
- Pattern E (aggregate ≠ disclose): not applicable (per-couple extraction).
- Pattern F (anchoring): some named examples (`"Mconn"/"Erinhorrigan"`) are anti-patterns to reject — used correctly as exclusion examples, not as outputs to mimic.

Minor info: the phantom-partner section names live couples (`"Hannah Lord & Hannah Lord"`, `"Brett & Brett"`). In a multi-venue rollout these become anchoring noise — the model may match real couples to these specific shapes. Recommend converting to abstract pattern descriptions (`<First> <Last> & <First> <Last>` where the two equal each other) in v3.

**Recommended rewrite (info-tier):** None required pre-launch; rephrase the phantom-partner examples as abstract shapes when revving to v3.

---

### 2. `couple-intel-derive.ts` — **WARNING (anchoring)**

**Severity:** warning.
**Tier:** sonnet.

The discipline rules are correct — voice-shape over raw evidence, sensitive themes get voice-shape only, persona is "discovered, not picked from an enum". Refusal field is required. But the prompt **lists 8 persona examples** which the model then disproportionately produces in real output.

**Patterns:**
- Pattern F (anchoring): The system prompt enumerates `"Heritage-Forward Planner"`, `"Cost-Conscious Pragmatist"`, `"Grief-Mediating Bride"`, `"Family-Diplomat"`, `"Deadline-Driven Booker"`, `"Vendor-Curious Explorer"`, `"Cultural-Fusion Couple"`, `"Pandemic-Postponed Replanner"`. These reappear verbatim in Wave 5B's `cohort-rollup.ts` system prompt and Wave 5D's `venue-thesis.ts` — three independent persona-discovery calls all see the same list. Convergence is by anchoring, not by data.

**Excerpt:**
> `Examples that might emerge from real data:`
> `- "Heritage-Forward Planner"`
> `- "Cost-Conscious Pragmatist"` ... (8 examples)
> `Do NOT force the label into one of the examples — let it emerge from the data.`

The "do not force" caveat does not undo anchoring in practice — LLMs match against the priming list.

**Recommended rewrite:** Drop the example list entirely or replace with one synthetic example whose tokens never appear in real venue data (e.g. `"Spreadsheet-First Maximizer"`).

---

### 3. `cohort-rollup.ts` — **WARNING (anchoring + leading example)**

**Severity:** warning.
**Tier:** sonnet.

Strong aggregate-disclose discipline; sensitivity-filtered counts are mandatory. Pattern-over-individual rule enforces ≥3 couples per claim. Refusal is required when persona has <3 couples.

**Patterns:**
- Pattern F (anchoring): consolidates persona labels from a known list ("Heritage-Forward Planner" + "Heritage-Forward Couple") — these are the Wave 5A examples cascading downstream.
- Pattern E (aggregate ≠ disclose): correctly enforced — "Do NOT name the couples involved", "report COUNTS only".
- Pattern B (leading discovery): borderline. The `conversion_correlations` section ships a specific example: `"couples mentioning grief who got a custom response within 4hrs"`. That's a pre-imposed pattern shape the model is likely to over-produce. Also ships a regional example `"couples with Korean-tea-ceremony interest"` — these are doctrine-defying because they pre-suggest WHICH cohorts to look for.

**Excerpt:**
> `Examples:`
> `- "couples mentioning grief who got a custom response within 4hrs"`
> `- "couples with Korean-tea-ceremony interest"`
> `- "couples who toured within 14d of inquiry"`

**Recommended rewrite:** Replace specific cohort-content examples with shape-only examples (`<emotional-theme> + <response-time-bucket>`, `<cultural-signal> interest`) so the model classifies whatever its data shows rather than hunting for these specific intersections.

---

### 4. `channel-role-classifier.ts` — **CRITICAL (pre-judged direction)**

**Severity:** critical.
**Tier:** sonnet.
**Doctrine violation:** Pattern A — assumption-loaded narrative.

This prompt is the canonical example the doctrine warns against. It is a forensic CLASSIFIER (acquisition vs validation vs conversion), and the prompt explicitly tells the model which way to lean BEFORE seeing the data.

**Patterns:**
- Pattern A (loaded narrative): rampant.
- Pattern B (leading discovery): rampant.
- Pattern D (evidence-quote): enforced via `key_evidence_signals` array — strong.

**Excerpts:**
> `The Knot / WeddingWire / HoneyBook patterns frequently end up here:` (in the "validation" definition)
> `Pre-inquiry signal absence is evidence. When a touchpoint claims acquisition but no pre-inquiry signal exists on the same platform, the burden of proof shifts: the touchpoint is more likely validation unless there's positive evidence otherwise.`
> `Common ambiguities you'll see: ... Lean validation on Knot — the Instagram chain is fresher and denser.`
> `... Lean validation when the same-platform signal is absent — the absence is evidence.`

This is exactly the doctrine anti-pattern. The classifier is being TOLD that Knot tends to be validation. If the data shows Knot is in fact acquisition (the operationally important case the doctrine specifically calls out), the classifier is prompted to override the evidence and reach for validation. The Wave 16 inquiry-intent-judge is a forensic descendant of this prompt — see finding 18 below.

**Recommended rewrite:** Strip every example sentence containing "lean" / "more likely" / "burden of proof shifts" / "Knot tends to". Restate the prompt as: "Classify the role based on the two observable signals (same-platform presence vs. absence). Report which signal you weighted and why. Confidence reflects evidence strength, not your prior."

---

### 5. `external-match.ts` — **CLEAN**

**Severity:** clean.
**Tier:** sonnet.

Scoring rubric is symmetric (90-100 down to 0-24), not directional. Anonymisation discipline is strict. Refusal discipline is explicit (sample <5, empty persona distribution, ambiguous signal). Key_signals array enforces evidence trace.

**Patterns:**
- Pattern F (anchoring): one example score-driver string (`"Heritage-Forward Planner: 32% share"`) appears in the rubric. Minor — recommend abstracting to `"<persona_label>: <share>%"` for v2.

---

### 6. `discovery-engine.ts` — **CRITICAL (pre-imposed hypothesis menu)**

**Severity:** critical.
**Tier:** sonnet.
**Doctrine violation:** Pattern A + Pattern B simultaneously.

This is the prompt the doctrine doc was written about. The discovery engine's WHOLE PURPOSE is to find unknown-unknowns — patterns the operator doesn't know to look for. The prompt then proceeds to enumerate 10 specific hypothesis types as examples, with the SAME framing the doctrine names as the anti-pattern.

**Patterns:**
- Pattern A (assumption-loaded): the first example hypothesis category is **the Knot-validation hypothesis** that triggered the doctrine doc on 2026-05-11.
- Pattern B (leading discovery): explicitly tells the model what categories to find.
- Pattern F (anchoring): 10 specific snake_case category names that the validator then enforces a 100-char cap on.

**Excerpts:**
> `Channel-role distortion: a channel that LOOKS like acquisition (lead form on Knot) but is actually validation (the couple already found the venue elsewhere and Knot is the easiest intake form). The fix flips the spend strategy.`
> `Use snake_case. If a familiar category fits, use it (channel_role_distortion, vendor_referral_unobserved, persona_channel_pattern, stale_warm_lead, booking_blocker_question, time_of_day_pattern, cross_platform_drift, competitor_positioning, demographic_clustering, conversion_rate_disparity). If none fits, invent one — that's the design.`

The "invent one" caveat is too weak to overcome the priming. In every Wave 7A run on dev data, the discovery engine has been observed reusing the 10 priming categories almost exclusively — not because the data converges to those, but because the prompt told it to.

The bigger doctrine violation is **the framing of WHY**. The prompt narrates "Knot LOOKS like acquisition but is ACTUALLY validation" — the conclusion. The model is being shown the answer before being asked to look.

**Recommended rewrite:** Delete the 10 named category list. Keep the abstract description of what discovery is (pattern over-/under-performance, cohort surprises, temporal patterns) but strip every specific channel / persona / direction example. Frame as: "Surface up to 5 patterns the operator probably doesn't know about. Could be over- OR under-performing channels. Could be persona surprises in EITHER direction. Could be timing patterns."

---

### 7. `venue-thesis.ts` — **WARNING (anchoring)**

**Severity:** warning.
**Tier:** sonnet.

Strong aggregate-disclose discipline. Refusal threshold (~30 couples) is explicit. `over_indexed_personas` must reuse Wave 5A labels — the right constraint.

**Patterns:**
- Pattern F (anchoring): five archetype examples (`"Heritage-Forward Family Estate"`, `"Cost-Conscious Outdoor Venue"`, `"Cultural-Celebration Specialist"`, `"Multi-Generational Garden Wedding"`, `"Destination-Adjacent Boutique"`). Same family-of-anchors problem as findings 2 and 3.
- Pattern A: not detected at the venue-thesis level — the conversion_signature examples reference numbers, not direction.

**Recommended rewrite:** Replace the 5 archetype examples with one synthetic example whose tokens never appear in real venue data, OR delete the list and let the data drive.

---

### 8. `marketing-recommendations.ts` — **WARNING (full counterfactual leaks direction)**

**Severity:** warning.
**Tier:** sonnet.

Strongly structured. Counterfactual + payback timeline + n_too_small_warning are mandatory. Refusal discipline is enforceable.

**Patterns:**
- Pattern A (loaded narrative): the FULL EXAMPLE recommendation in the system prompt is a Knot-to-Instagram reallocation for Heritage-Forward. The example includes specific dollar amounts ("$800/mo"), specific CACs ("$180 vs $90"), specific lift counts. The model is being shown a finished answer — every Wave 6C run on dev data closely mimics this example's shape.
- Pattern F (anchoring): same example.

**Excerpt:**
> `"recommendation_title": "Move 30% of Knot spend to Instagram for Heritage-Forward",`
> `"recommendation_text": "Knot × Heritage-Forward (n=14) shows CAC=$180 and 8% conversion. Instagram × Heritage-Forward (n=22) shows CAC=$90 and 22% conversion in the same 90-day window. Reallocating $800/mo of Knot spend to Instagram is projected to add 2-3 bookings/mo ..."`

This is the doctrine anti-pattern at recommendation-engine level. Wave 6C is supposed to surface the operator's actual data — it instead echoes this scripted Knot-to-Instagram narrative because the prompt anchors it.

**Recommended rewrite:** Replace the full worked example with a SHAPE-ONLY example: "<source_channel> × <persona> shows CAC=<x>, <other_channel> × <persona> shows CAC=<y>, reallocate based on the gap direction." Strip all specific dollar figures and channel names from the example.

---

### 9. `hypothesis-validator.ts` — **CLEAN**

**Severity:** clean.
**Tier:** sonnet (both designer + interpreter calls).

Two-call architecture is sound (designer separated from interpreter). Refusal discipline is strong on both sides (designer can refuse untestable hypotheses; interpreter has the explicit `data_too_thin` verdict). The interpreter prompt is appropriately neutral — verdict rules are symmetric across `validated / refuted / inconclusive / data_too_thin`.

**Patterns:**
- Pattern A: not detected. Designer doesn't pre-judge.
- Pattern B: not detected.
- Pattern D (evidence-quote): not directly applicable (numerical test); replaced by required numerical citation in the `reasoning` field — appropriate.

One info note: the designer prompt lists "Lift threshold 15-50% typical for venue-scale cohorts" — this is fine as a calibration anchor, not an assumption about direction.

---

### 10. `marketing-digest.ts` — **WARNING (full example bias)**

**Severity:** warning.
**Tier:** sonnet.

Narrator discipline is correct — composes, does not invent. Refusal discipline is explicit. The model only re-emits structured evidence and writes a narrative wrapper.

**Patterns:**
- Pattern F (anchoring): a fully-worked example output is shown, including the EXACT Knot-CAC + Heritage-Forward narrative from finding 8. The digest narrator has been observed reaching for this exact shape even when the venue's data points elsewhere.

**Recommended rewrite:** Replace the example with abstract placeholders (`"<top_flag_title>"`, `"<top_recommendation_title>"`) — the narrator's job is composition, not invention, so the example doesn't need filled-in numbers.

---

### 11. `discovery-digest.ts` — **INFO (mild anchoring)**

**Severity:** info.
**Tier:** sonnet.

Narrator pattern, same shape as marketing-digest. Re-emits validated discoveries + pending high-confidence + feedback actions. Refusal discipline correct.

**Patterns:**
- Pattern F (anchoring): the worked example again echoes the Knot-validation hypothesis. Recommend replacing with a non-Knot abstract example.

---

### 12. `referral-extractor.ts` — **CLEAN**

**Severity:** clean.
**Tier:** haiku.

Strong forensic extractor. Verbatim quote required. Confidence rubric ties to explicit verb shapes ("recommended us", "told us about", "heard from") — not direction-loaded. Refusals required when confidence <30. The do-NOT-extract list is helpful (rules out generic vendor names, platform mentions, self-references).

**Patterns:**
- Pattern D (evidence-quote): enforced.
- Pattern A: not detected.

---

### 13. `lifecycle-transition.ts` — **CLEAN**

**Severity:** clean.
**Tier:** haiku.

Backbone state-machine judge. Explicitly forbidden from back-tracking unless evidence is overwhelming — the correct direction-bias because the state machine itself enforces forward progression. The "no-back-tracking" bias is structural, not measurement bias. Refusal discipline is the safe-action default.

**Patterns:**
- Pattern A: not detected. The bias is acknowledged and structural — the doctrine's "measure don't assume" rule doesn't apply when the system is making a procedural decision.

---

### 14. `alumni-cohort.ts` — **WARNING (anchoring)**

**Severity:** warning.
**Tier:** sonnet.

Strong aggregate-only discipline (`NEVER name a specific couple`). The data-density-to-archetype-count rule is explicit. Each archetype requires booked_count ≥ 2 with refusal for singletons.

**Patterns:**
- Pattern F (anchoring): six archetype examples (`"Heritage-Forward Planner Cohort"`, `"Cost-Conscious Pragmatist Cohort"`, etc.). Same family of names that propagate from finding 2.

**Recommended rewrite:** Drop or replace the named examples — let the data drive.

---

### 15. `tour-prep-brief.ts` — **CLEAN**

**Severity:** clean.
**Tier:** sonnet.

Strong voice-shape discipline. Sensitive themes route through `sensitivity_flags` with `handle_with` coaching, never quoted. Key_facts must carry `why_it_matters`. Refusal discipline is explicit.

**Patterns:** none of A/B/C/D/E/F detected in problematic form. The `partner1 is a nurse` example is generic enough not to anchor.

---

### 16. `post-tour-sage.ts` — **CLEAN**

**Severity:** clean.
**Tier:** sonnet.

Tone discipline for outcome (completed / no_show / cancelled) is correctly directional — guilt-tripping is forbidden, brevity is bounded. The "one specific reference" rule is strong against generic-template drift.

**Patterns:** none problematic.

---

### 17. `review-solicit.ts` — **CLEAN**

**Severity:** clean.
**Tier:** sonnet.

Channel-specific guidance (Knot / WeddingWire / Google / Yelp / Facebook) is procedural not directional — telling the model how each platform's form is shaped, not what verdict to reach. No-pressure + no-incentives rules are correct. The "one specific reference" rule is enforced.

**Patterns:** none problematic.

---

### 18. `inquiry-intent-judge.ts` — **CRITICAL (pre-judged direction)**

**Severity:** critical.
**Tier:** haiku.
**Doctrine violation:** Pattern A — assumption-loaded narrative. THIS IS THE PROMPT THE DOCTRINE WAS WRITTEN ABOUT.

The Wave 16 inquiry-intent-judge classifies inquiries as targeted / broadcast / validation. It then tells the model a specific direction to lean:

**Excerpts:**
> `Strong indicator: matched_patterns count >= 2 AND post-inquiry interactions == 0 AND tour bookings == 0` (in the broadcast definition)
> `Template score is forensic ground but not destiny. A 50 score means roughly half-broadcast, half-personalised signals. Tip the scale toward broadcast when post-inquiry engagement is zero; tip toward targeted when post-inquiry engagement is present.`

The rules themselves are forensic and defensible. But the prompt is then **wrapped in a narrative** (`bloom-may11... ambiguous-zone judge`) that pre-imposes the direction the Wave 16 measurement system is supposed to discover. The doctrine doc explicitly cites this prompt — "broadcast converts worse" — as the false assumption.

The judge IS supposed to commit to a class. But the prompt currently steers the commit. The fix is to keep the rules and drop the direction-loaded preamble.

**Recommended rewrite:** Replace "tip the scale toward X when Y" with "weight Y as evidence of class X, and weight Z as evidence of class W — confidence reflects the strength of the dominant signal, not your prior."

---

### 19. `universal-rules.ts` — **INFO (banned-phrase list could anchor)**

**Severity:** info.
**Tier:** n/a (layered into Sage personality engine).

Strong rule scaffold. AI-transparency rule is non-overridable (correct). Anti-hallucination protocol is explicit. Soft-context notes policy enforces sensitive-themes voice-shape only.

**Patterns:**
- Banned-phrase list and seasonal-language list are anchoring vectors but mostly benign (intentional anchoring for venue voice). One concern: the "Sensitive themes ... never echo back" rule says "A couple mentioning grief should hear gentleness, not a quote of their loss." Good. But "A couple flagged 'hates flowers' should not get a flowers-themed reply" assumes the flag exists at extraction time — confirms that Wave 4's sensitive=true tagging is the gate.

---

### 20. `coordinator-rules.ts` — **CLEAN**

**Severity:** clean.

Numbers-discipline rule (`NUMBERS YOU MAY USE block`) is strong. Absolute-certainty phrase ban ("always", "definitely", "100%", "will book") is exactly the doctrine antidote — coordinator narrators are forbidden from over-claiming. This file is doing more work to enforce measure-don't-assume than any other prompt.

---

### 21. `couple-rules.ts` — **CLEAN**

**Severity:** clean.

Tenant-isolation rule (no cross-couple references) is strict. Document-grounding rule (only quote from passed file context) is enforceable.

---

### 22. `task-prompts-{sage, inquiry, client, intel}.ts` — **INFO (no version constants + some loaded phrases)**

**Severity:** info.
**Tier:** sonnet via personality-engine wrap.

Four task-selector files for the layered prompt system. None export a `PROMPT_VERSION` constant — they're string literal banks. This means a regression audit on these surfaces cannot correlate cost / quality / revision via `api_costs.prompt_version`.

**Patterns:**
- Pattern A (mild): `task-prompts-inquiry.ts` says `WARM but not pushy ... Sell the appointment, not the venue` — directional, but for sales-output writing, not measurement. Not a doctrine violation.
- `task-prompts-intel.ts` `TASK_WEEKLY_BRIEFING` explicitly tells the model `Lead with what changed, not what stayed the same` and `Reference the pre-computed change percentages from the data block; do NOT compute new ones`. Strong numbers discipline that anticipates the doctrine.
- One concrete issue in `TASK_WEEKLY_BRIEFING`: `If a metric moved more than 20% (per the pre-computed deltas), explain WHY if possible`. Asking the model to invent an explanation is the doctrine concern — when no causal evidence is in the data block, the model is being primed to fabricate. Recommend changing to "explain WHY using ONLY the correlations supplied in the data block; otherwise say 'no clear driver in this week's data'."

**Recommended rewrite:** Add `PROMPT_VERSION` constants to all four files so tier-correctness sweeps can correlate revisions. Soften the "explain WHY if possible" line.

---

## Recommended next actions (ranked by severity)

### Critical (fix before any new Wave 16/7A/7B run on Rixey)
1. **`discovery-engine.ts`** (Wave 7A) — strip the 10 named hypothesis categories and the "Knot validation" example narrative. Replace with abstract pattern shapes. This is the prompt the doctrine doc was written for.
2. **`channel-role-classifier.ts`** (Wave 7B) — strip "lean validation" / "burden of proof shifts" sentences. Re-express as symmetric evidence weighting.
3. **`inquiry-intent-judge.ts`** (Wave 16) — strip "tip the scale toward broadcast" directional language. Re-express as symmetric signal weighting.

### Warning (fix in the next prompt revision cycle)
4. **`couple-intel-derive.ts`** — drop the 8 persona-label examples (anchor cascade source).
5. **`cohort-rollup.ts`** — replace the cohort-content examples with shape-only examples.
6. **`venue-thesis.ts`** — drop or replace the 5 archetype examples.
7. **`marketing-recommendations.ts`** — replace the worked Knot-to-Instagram example with shape-only.
8. **`marketing-digest.ts`** — replace the worked example with abstract placeholders.
9. **`alumni-cohort.ts`** — drop or replace the 6 archetype examples.

### Info (cleanup)
10. **`discovery-digest.ts`** — replace the Knot-validation worked example.
11. **`identity-reconstruction.ts`** — abstract the live-couple phantom-partner names when revving to v3.
12. **`external-match.ts`** — abstract the `"Heritage-Forward Planner: 32% share"` placeholder.
13. **`task-prompts-*.ts`** — add `PROMPT_VERSION` constants; soften "explain WHY if possible" in the weekly briefing prompt.

### Cross-cutting recommendation
The persona-label anchoring cascade (`couple-intel-derive` → `cohort-rollup` → `alumni-cohort` → `venue-thesis`) is a single bug in four places. Recommend a shared `persona-style-guide` constant that EVERY persona-producing prompt imports, where the guide is shape-only ("2-4 words, evocative, grounded in cohort data") with **zero specific examples**. That removes the priming cascade in one edit.

---

## Audit verification

- Every prompt file in `src/config/prompts/` covered.
- Tier-mapping verified against call-sites in `src/lib/services/` (Sonnet vs Haiku per file documented in inventory table).
- Doctrine anchor (`feedback_measure_dont_assume.md`) cited explicitly for the 3 critical findings — all 3 are the same anti-pattern (pre-judged direction in a measurement system).
- No prompt files were modified by this audit.
