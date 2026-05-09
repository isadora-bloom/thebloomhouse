# AI vs Templated-as-AI Audit

Bloom House surfaces, classified by whether user-facing output comes from a real LLM call, a hybrid (rules + LLM), or a templated/heuristic detector dressed up as AI.

## TL;DR

- Audited **~30 surfaces** that produce coordinator/couple-facing text.
- **Real LLM**: 16
- **Hybrid (rules + LLM polish)**: 7
- **Templated-as-AI (the bug)**: 7

The known precedents (cultural-moments-auto-propose, settings/personality preview) are not isolated. The same shape — `intelligence_insights` rows or "AI-generated" UI labels backed by deterministic templates — appears across the intelligence-engine detector pack, weather-cancellation, availability anomalies, weekly-learned, attendee-intelligence, and a templated fallback that fires whenever the cost-ceiling gate closes for any insight surface.

---

## Real AI (LLM-backed)

| File | Surface | Prompt version |
| --- | --- | --- |
| `src/lib/services/brain/sage.ts`, `inquiry.ts`, `client.ts` | Couple Sage chat / inquiry email replies | `inquiry.prompt.v*` (real LLM, confirmed) |
| `src/lib/services/brain/review-response.ts:24` | Review response drafts | `review-response.prompt.v1` |
| `src/lib/services/brain/post-tour-brief.ts:35` | Post-tour brief markdown + follow-up draft | `post-tour-brief.prompt.v1.0` |
| `src/lib/services/brain/re-engagement-drafter.ts:31` | Re-engagement messages | `re-engagement-drafter.prompt.v1.0` |
| `src/lib/services/brain/journey-narrative.ts:27` | Cross-source journey narrative | `journey-narrative.prompt.v1.0` |
| `src/lib/services/brain/voice-dna-extract.ts:57` | Voice DNA extraction | `voice-dna-extract.prompt.v1.0` |
| `src/lib/services/brain/cancellation-classifier.ts` | Free-text → cancellation reason enum | `cancellation-classifier.prompt.v1` |
| `src/lib/services/brain/intel-brain.ts` `generatePositioningSuggestions` (l. 1590, 1688) | Market-pulse positioning suggestions | LLM (callAIJson) |
| `src/lib/services/intel/trends.ts:419` `generateTrendRecommendations` | Trend recommendations | `trend_recommendations` task |
| `src/lib/services/intel/briefings.ts:465, 655` | Weekly + monthly briefings (summary, trend highlights, recommendations) | `briefings.prompt.v1.0`, `briefings.monthly.v1.0` |
| `src/lib/services/intel/daily-digest.ts:443` | Daily digest summary paragraph | `daily-digest.prompt.v1.0` |
| `src/lib/services/intel/weekly-digest.ts:650` | Dynamic weekly digest summary | LLM via callAIJson |
| `src/lib/services/inbox/folder-ai-classifier.ts:39` | Inbox folder lifecycle classifier | `inbox-folder-ai.prompt.v1.0` |
| `src/lib/services/lifecycle/signal-detector.ts:38` | Lifecycle signal detector (lead_declined etc.) | `lifecycle.signal.v1.0` |
| `src/lib/services/intel/asset-matcher.ts:40` | Auto-attach photo matcher | `asset-matcher.prompt.v1.0` |
| `src/lib/services/tour/transcript-extract.ts` | Tour transcript extraction | LLM |

---

## Hybrid (deterministic detector + LLM narration)

These surfaces compute a classical pass (rules / thresholds / aggregations) and then call an LLM to compose the user-facing prose. The deterministic numbers are the truth; the LLM only narrates them. All of them include a deterministic-template fallback that fires when `gateForBrainCall` closes (cost ceiling) or the LLM fails — so under load, the surface degrades to a template silently.

| File | What's classical | What's LLM | Fallback path |
| --- | --- | --- | --- |
| `src/lib/services/insights/heat-narration.ts:130, 322` | Trajectory bucketing, top-events, cohort damping | 1-2-sentence reasoning + action | l. 498-549 verb/trajectory/cohort template |
| `src/lib/services/insights/risk-flags.ts:106-295` | 7 rule-based flag detectors + composite score | Sentiment scan + summary narration | l. 470-480 deterministic title/body |
| `src/lib/services/insights/decay-re-engagement.ts` | Heat-decline change-point + unresolved questions | Cause classification + recommendation | template scaffold in `narration` block |
| `src/lib/services/insights/negotiation-state.ts` | Inbound interaction count + recency | Phase classifier (early_research → pending_contract) | Fallback to rule-derived phase |
| `src/lib/services/insights/cohort-match.ts` | K=10 z-scored similar weddings, conversion stats | 1-2-sentence diagnostic + recommendation | classical numeric body |
| `src/lib/services/insights/pricing-elasticity.ts` | Pre/post conversion + elasticity formula | Narration polish, "inconclusive" framing | classical body |
| `src/lib/services/insights/correlation-narration.ts:1-100` | Engine writes statistical correlations | Sonnet adds 2-3-sentence story | l. 35: "deterministic fallback narrates the engine's headline body verbatim. Never block the surface on AI." |
| `src/lib/services/intel/anomaly-detection.ts:714-781` (metric anomalies) | Threshold-vs-baseline rule detector | LLM hypothesis chain (causes ranked + actions) | `aiResult?.explanation ?? null` (l. 891) — degraded silently to null |

These are NOT bugs in the same sense as below — the LLM enrichment is the headline value — but coordinators should know the fallback exists. When the LLM call fails or the gate is closed, the same `intelligence_insights` row is shown with the deterministic body, no badge differentiating it.

---

## Templated-as-AI (the bug list)

### 1. `src/lib/services/intel/intelligence-engine.ts` (whole file, ~1200 lines)

- **What the user sees**: 14 detectors writing to `intelligence_insights` (the table consumed by `InsightCard` + `/intel/dashboard` "AI Insights" panel + `/intel/insights` page). Examples of titles emitted (lines 156, 264, 314, 434, 470, 566, 598, 711, 767, 891, 1011, 1034, 1164):
  - "30s responses convert 2.3x vs 24h+"
  - "Tuesday tours convert at 42% vs 18% on Sundays"
  - "The Knot books at 18% vs Direct at 6% — quality over volume"
  - "$X% of lost deals cite 'budget' — N of last M"
- **Why it's not really AI**: the file's own header (l. 13) says it explicitly: `body/action text uses template strings, not AI (AI is for weekly digest)`. Every body/action is a `\`${best.day} ... ${pct(...)}%\`` template fill.
- **Why it's labeled as AI**: `/intel/dashboard` describes the panel as "AI-generated insights at a glance" (line 606), the Pending Recommendations stat tile reads "AI-generated action items awaiting review" (l. 773-774), and `InsightPanel` rendered below uses the same `Sparkles`/`Brain` iconography as the LLM-narrated rows from `risk-flags`, `heat-narration`, etc. Coordinators cannot distinguish a templated `intelligence-engine` row from a real LLM-narrated `heat_narration` row in the same list.
- **Recommended fix**: Either (a) relabel honestly as "Pattern detection / data-driven" and reserve "AI" / "Sage" for LLM-narrated rows, or (b) add a numbers-guarded LLM narration layer over the classical detector outputs (same pattern as `correlation-narration.ts` does on top of `correlation-engine`).

### 2. `src/lib/services/insights/cultural-moments-auto-propose.ts:42, 182, 244`

- **What the user sees**: Cultural moments queue at `/intel/cultural-moments` shows `proposed_by='ai'` rows with titles like "Wedding-search demand spike", "Engagement-intent spike (3-12mo pipeline)", "Sentiment headwind: divorce-search uptick".
- **Why it's not really AI**: `titleForSpike` (l. 182) is a static branch on `(termCategory × direction)`. `buildProposeArgs` (l. 244) composes a description with `${spike.recentAvg}` / `${spike.baselineMean}` — pure z-score template output. No LLM call anywhere in the file.
- **Recommended fix**: this is what the diagnosis already calls out (Agent G is shipping `cultural-moments-llm-propose`). Confirmed; do not duplicate the work here.

### 3. `src/lib/services/insights/weather-cancellation.ts:235-247`

- **What the user sees**: Insight card on `/intel/insights` with `insight_type='correlation_narration'` and titles like "Weather drives tour cancellations: 42% cancel rate on heavy-rain days vs 18% baseline".
- **Why it's not really AI**: The title, body, and action strings (l. 235-247) are deterministically composed from bucket counts. No `callAI` / `callAIJson` import in the file — the persist path is a direct `intelligence_insights` insert (l. 280-318), bypassing `insights/persist.ts` and the numbers-guard. The comment at l. 230 admits it: `we use the older direct-row pattern (rather than insights/persist.ts which requires LLM-narration shape) because the title + body here are deterministically composed`.
- **Why it's labeled as AI**: It uses `insight_type='correlation_narration'`, which is the SAME type written by `correlation-narration.ts` (a real LLM narration). On `/intel/insights` and `/intel/macro-correlations` they render identically through `InsightCard`. A coordinator filtering on "Correlation" gets a mix of LLM-narrated and templated rows in the same list.
- **Recommended fix**: Either rename to `insight_type='weather_cancellation'` so it carries its own type (deterministic-by-design, separate label), or pass through `insights/persist.ts` with a real LLM narration layer.

### 4. `src/lib/services/intel/anomaly-detection.ts:944-1143` (`detectAvailabilityAnomalies`)

- **What the user sees**: Anomaly alerts on `/intel/anomalies` with `ai_explanation` populated, e.g. "Saturdays in October are filling fast; weekdays still wide open" or "Unusually high demand for October dates. Currently 18/22 slots filled."
- **Why it's not really AI**: The function's docstring (l. 942) explicitly says `Uses static templates for ai_explanation (no AI call). Idempotent...`. Both branches at l. 1052-1057 hardcode the explanation string. The column is named `ai_explanation` and surfaces alongside `runAnomalyDetection` rows where `ai_explanation` IS a real LLM hypothesis (l. 730-774).
- **Why it's labeled as AI**: Same column (`ai_explanation`) and same `anomaly_alerts` table — coordinator UI doesn't distinguish source. Two rows on the same page, one says "Heat dropped because the coordinator was on vacation Mar 10-17" (real LLM via `getAIExplanation`), the other says "Saturdays in October are filling fast; weekdays still wide open" (template). Both render under "AI explanation".
- **Recommended fix**: Add a column `explanation_source` (`'ai'` | `'rule'`) or split into two tables. At minimum, relabel templated rows so the UI distinguishes.

### 5. `src/lib/services/intel/weekly-learned.ts` + `src/components/intel/WeeklyLearnedCard.tsx`

- **What the user sees**: Card on `/intel/dashboard` titled "What [Sage] learned this week" with bullets like "Sage learned 5 new voice preferences this week from your training games and review approvals."
- **Why it's not really AI**: The bullets are deterministic count-based templates (l. 95-118: `${aiName} learned ${prefs} ${plural} this week...`). The "voice" / "booking" / "source" / "correlation" / "multi_touch_journey" bullets are SQL counts wrapped in templated strings. No LLM call in `weekly-learned.ts` for the bullet text.
- **Why it's labeled as AI**: `aiName` is interpolated into every bullet, framed as "Sage learned X." This anthropomorphizes a count query as an act of AI learning.
- **Recommended fix**: Reword to factual ("Voice training: 5 new preferences this week") and drop the "[Sage] learned" framing, OR feed the structured counts into an LLM that composes a 2-3-sentence weekly observation.

### 6. `src/lib/services/tour/attendee-intelligence.ts:122-141`

- **What the user sees**: `topInsight` field on tour attendee analysis, surfaced wherever the API exposes it: e.g. "Parents have booked at 65% vs an overall 42% at your venue." Framed as a learned insight.
- **Why it's not really AI**: l. 132 is a hardcoded format string filling per-bucket booking rates. The "intelligence" is a comparison-against-mean.
- **Why it's labeled as AI**: filename is `attendee-intelligence.ts`; `topInsight` is the framing.
- **Recommended fix**: Rename to `attendeeBookingRateOutlier` or pass through an LLM narrator the same way cohort-match does.

### 7. Knowledge gaps (`src/lib/services/intel/knowledge-gaps.ts`) + UI `/agent/knowledge-gaps`

- **What the user sees**: a backlog of "questions Sage couldn't answer", with frequency counts.
- **Why it's not really AI**: l. 18-23 spell it out — questions are extracted by the upstream classifier, then this service does case-insensitive normalisation, dedup, and frequency bumping. No LLM in this file.
- **Why it's grey**: this is technically OK because the QUESTIONS came from a real LLM extraction in the classifier. But the page presents it as "Sage's knowledge gaps" without surfacing that gap categorisation/clustering is explicitly deferred (l. 25: `Category left null by default; categorisation is a Phase 4 concern once we have embedding clustering`).
- **Recommended fix**: minor — either ship the embedding clustering (Phase 4 deferred) or relabel the page as a question backlog rather than AI-derived gaps.

---

## Recommended fix order (by user-visible impact)

1. **`intelligence-engine.ts` (14 detectors)** — biggest blast radius. Pending Recommendations on `/intel/dashboard` and the entire `/intel/insights` page mix templated detector rows with LLM-narrated `risk_flag`/`heat_narration`/`cohort_match`/etc. rows under the same "AI Insights" label. Fix by adding a numbers-guarded narration layer (~6 detector flavors → 6 prompts) or by relabeling.
2. **`weather-cancellation.ts`** — writes `insight_type='correlation_narration'` impersonating the real LLM-narrated correlation rows. Fastest fix: rename the type. Right fix: route through `insights/persist.ts` with an LLM narrator.
3. **`detectAvailabilityAnomalies` in `anomaly-detection.ts`** — populates `ai_explanation` column with templates. Coordinators cannot tell the difference from real `getAIExplanation` rows.
4. **`cultural-moments-auto-propose.ts`** — already in flight (Agent G). Mentioned for completeness.
5. **`weekly-learned.ts` "[Sage] learned X this week"** — small surface, but the anthropomorphic phrasing is the loudest signal of "AI-washing" templated counts.

---

## Cross-cutting suggestion

Adopt a labeling rule: **only use "Sage" / "AI-generated" / "[Sage] learned" / `Brain` / `Sparkles` iconography when the user-visible string was produced by a `callAI` / `callAIJson` / `callAIVision` invocation traceable through `BRAIN_PROMPT_VERSION` and logged to `api_costs`.**

Concrete enforcement:

1. Add a `narration_source` enum to `intelligence_insights` and `anomaly_alerts`: `'llm'` | `'rule'` | `'hybrid'` | `'fallback_after_llm_failure'`. Populated by writers; read by the UI to render a small badge.
2. Lint rule (or grep CI check): any file matching `src/lib/services/insights/**` or `src/lib/services/intel/**` that writes `body` / `title` / `action` to `intelligence_insights` MUST either import `callAI`/`callAIJson`/`callAIVision` OR set `narration_source='rule'`.
3. Hybrid surfaces (heat-narration, risk-flags, decay-re-engagement, etc.) should mark their fallback path explicitly: when the deterministic template fires (cost ceiling closed, LLM failed), persist `narration_source='fallback_after_llm_failure'` so the UI can show "showing rule-based fallback because AI was paused" rather than passing it off as a real Sage narration.
4. Filenames that contain `intelligence`, `brain`, `learned`, `auto-propose` should require an `BRAIN_PROMPT_VERSION` constant. Files without one (e.g. `intelligence-engine.ts`, `attendee-intelligence.ts`, `weekly-learned.ts`) get an explicit `// HEURISTIC ONLY — no LLM` banner at the top.
