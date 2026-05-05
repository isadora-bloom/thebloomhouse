# Prompts Changelog

Per-prompt revision history. Each brain module exports a
`BRAIN_PROMPT_VERSION` constant that gets logged to
`api_costs.prompt_version` on every call and stamped onto
`drafts.prompt_version_used` at insert time. Bump the constant when
the system prompt or task prompt structure changes meaningfully —
small wording tweaks below the cost-of-bumping threshold can stay on
the current version, but anything that could plausibly move output
quality / cost / latency should bump and get an entry here.

Per Playbook OPS-21.5.1 / BUILD-PLAN T1-E.

## Versioning rule

`<module-name>.prompt.v<MAJOR>.<MINOR>`

- **MAJOR** — task contract change (e.g. response format, brain
  scope, new layer added). Bump invalidates any prompt-version-keyed
  cache.
- **MINOR** — wording / instruction refinement that holds the
  contract. Bumps still get a changelog row.

## 2026-05-05

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| anomaly-detection | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| brain-dump | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| briefings (weekly) | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| briefings (monthly) | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| candidate-ai-adjudicator | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| daily-digest | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| data-detection | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| extraction | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| planning-extraction | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| marketing-spend | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| bar-recipe-extract | — | v1.0 | Initial versioning; image path rewired through callAIVision (T1-E / OPS-21.5.1) |

## Per-brain history

### inquiry-brain (`inquiry-brain.prompt.v1.1`)
- **v1.1** (2026-05-02) — T5-schema-gap (migration 165). EXTRACTED
  DATA context block now emits a "Headcount status: KNOWN | NOT YET
  CAPTURED" line so Sage knows whether to ask for guest count. Paired
  with `task-prompts-inquiry.ts` "GATHER PERSONALIZATION DETAILS"
  edit that says don't infer a number from "small / intimate / large".
- **v1.0** (2026-05-01) — Initial versioning baseline. Captures the
  4-layer assembly (UNIVERSAL_RULES + personality + task prompt +
  learning block) as it stands at T1-E land.

### client-brain (`client-brain.prompt.v1.0`)
- **v1.0** (2026-05-01) — Initial versioning baseline. UNIVERSAL_RULES
  + CLIENT_RULES + personality + task prompt + learning block.

### sage-brain (`sage-brain.prompt.v1.0`)
- **v1.0** (2026-05-01) — Initial versioning baseline. 4-layer assembly
  with KB context + intelligence-context block. Tier-1 content (couple
  PII, family context).

### router-brain (`router-brain.prompt.v1.1`)
- **v1.1** (2026-05-02) — T5-schema-gap (migration 165). Added
  `estimatedGuests` extraction field with explicit guidance for
  ranges (take midpoint), approximate phrasing ("around 150"), the
  1-1000 range gate, and the do-not-infer-from-adjectives rule for
  "small / intimate / large". Lands in `weddings.estimated_guests`.
- **v1.0** (2026-05-01) — Initial versioning baseline. Email
  classification on Haiku (per OPS-21.4.2) with the 7-class label set.

### intel-brain (`intel-brain.prompt.v1.1`)
- **v1.1** (2026-05-02) — T5-Rixey-PP. NLQ context-loader gaps closed
  per Stream MM real-data load (Q4 "busiest tour month" returned
  ungrounded; Q1 "Google Ads ROI" needed a manual cron refresh first).
  `gatherVenueData` now pulls (a) `toursByMonth` — last 12 months of
  tours bucketed by `scheduled_at` UTC month with completed / cancelled
  / no_show / rescheduled / pending breakdown, and (b)
  `marketingSpendByMonth` — direct read of `marketing_spend` rows
  (source × month × amount × notes) to give Sage always-fresh per-month
  spend without depending on the weekly `source_attribution` cron.
  System prompt updated to describe both blocks, plus a clarifying note
  on SOURCE ATTRIBUTION explaining the cron-freshness caveat and
  pointing the LLM at MARKETING SPEND BY MONTH for recent-spend
  questions.
- **v1.0** (2026-05-01) — Initial versioning baseline. Covers both NLQ
  (`generateNLQResponse`) and positioning suggestions
  (`generatePositioningSuggestions`).

### post-tour-brief (`post-tour-brief.prompt.v1.0`)
- **v1.0** (2026-05-01) — Initial versioning baseline. Brief composer
  + follow-up draft composer. Tier-1 content (transcript-derived
  family/financial intelligence).

### heat-narration (`heat-narration.prompt.v1.1`)
- **v1.1** (2026-05-02) — T5-followup-AA. Trajectory bucket
  (rising / falling / plateau / volatile / unknown) added to the
  user prompt + system prompt instructions so the LLM grounds
  prose in heat direction over the last ~14 days, not just the
  static score. Prompted action selection now keys on (tier ×
  trajectory) — same warm score reads "stabilise with a clarifying
  call" when volatile vs "send a tour follow-up" when steady.
  Cache key gains a `trajectory` field so a wedding climbing 40→55→70
  and a wedding crashing 100→85→70 don't collapse onto the same
  cached prose. ONE more cache-miss vector by design — the platform
  underreports volatility today. 4 buckets (+ unknown) is enough.
- **v1.0** (2026-05-01) — Initial versioning baseline. T3-A heat
  narration generator. Sonnet-tier; deterministic fallback runs when
  cost ceiling pauses the venue.

### cancellation-classifier (`cancellation-classifier.prompt.v1.0`)
- **v1.0** (2026-05-02) — T5-Rixey-JJ. Free-text → enum classifier for
  tour cancellation reasons. Mirrors migration 176's extended CHECK
  enum (lost_to_competitor / venue_unavailable / health_emergency
  added beyond migration 166's original 8). Two-stage: heuristic over
  the dominant Rixey Calendly patterns first, then LLM (Sonnet, tier-1
  content, cost-ceiling-gated, FNV-1a-cached) for the long tail.
  Returns `{ reason, note, confidence: 'high'|'medium'|'low' }`.
  Empty / 'n/a' / single-char inputs short-circuit to 'other' / 'low'.
  Gated venues fall back to heuristic-only.

### voice-dna-extract (`voice-dna-extract.prompt.v1.0`)
- **v1.0** (2026-05-02) — T5-θ.3. Extracts greetings, signoffs, pet
  phrases, punctuation tics, voice rules, and sentence rhythm from a
  batch of coordinator-written outbound emails. Used for the Day-4
  onboarding seed pass over the 12-month Gmail backfill. Tier-1 content
  (outbound emails contain couple PII + sometimes family context).
  Sonnet-tier for the nuanced extraction; Haiku is too brittle on
  free-text style identification at this batch size.

### anomaly-detection (`anomaly-detection.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. AI hypothesis generation
  for metric anomalies with Internal Context bundle (absences, operational state,
  pricing changes, marketing channels). Haiku tier.

### brain-dump (`brain-dump.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. 7-intent classifier
  (client_note / availability / analytics / staff_observation / operational_note /
  knowledge_base_import / ambiguous). Haiku tier, tier-1 content.

### briefings (`briefings.prompt.v1.0` / `briefings.monthly.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Weekly briefing uses
  `BRIEFING_PROMPT_VERSION`; monthly uses `MONTHLY_BRIEFING_PROMPT_VERSION`.
  ANTI-19.9-A numbers-discipline guard in both prompts.

### candidate-ai-adjudicator (`candidate-ai-adjudicator.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Tier 2 ambiguous-match
  adjudicator: bounded JSON schema (match_wedding_id + confidence + reasoning).
  Haiku tier per OPS-21.4.2.

### daily-digest (`daily-digest.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. 2-3 sentence morning
  summary for coordinator. Sonnet tier.

### data-detection (`data-detection.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Covers both detectDataType
  (24-class classification) and mapColumns (source→target dict). Haiku tier.

### extraction (`extraction.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Structured signal extraction
  from inquiry email bodies (30-field schema). Haiku tier.

### planning-extraction (`planning-extraction.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Wedding planning decision
  extraction from Sage chat messages (8-category schema). Sonnet tier.

### marketing-spend (`marketing-spend.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Free-text → structured
  spend rows (source / month / amount). Sonnet tier.

### bar-recipe-extract (`bar-recipe-extract.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Covers URL extraction
  (via callAIJson) and upload extraction. Image uploads rewired through callAIVision
  so circuit breaker and cost logging apply. PDF path retains direct SDK call
  (document block) with manual api_costs insert + promptVersion. Sonnet tier.

## Adding a new brain prompt

1. Export `BRAIN_PROMPT_VERSION` at the top of the brain file.
2. Pass `promptVersion: BRAIN_PROMPT_VERSION` to every `callAI` /
   `callAIJson` / `callAIVision` call inside the brain.
3. If the brain produces drafts, the consumer that inserts the draft
   row imports the constant and stamps `prompt_version_used`.
4. Add a row to this changelog under that brain's section.

## Bumping an existing version

1. Edit the prompt.
2. Increment the constant in the brain file.
3. Add a changelog row with date + reason + behavioural impact.
4. (Optional) Open a follow-up to compare api_costs cost / latency /
   confidence_score distribution before vs after the bump.
