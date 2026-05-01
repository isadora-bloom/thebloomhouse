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

## Per-brain history

### inquiry-brain (`inquiry-brain.prompt.v1.0`)
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

### router-brain (`router-brain.prompt.v1.0`)
- **v1.0** (2026-05-01) — Initial versioning baseline. Email
  classification on Haiku (per OPS-21.4.2) with the 7-class label set.

### intel-brain (`intel-brain.prompt.v1.0`)
- **v1.0** (2026-05-01) — Initial versioning baseline. Covers both NLQ
  (`generateNLQResponse`) and positioning suggestions
  (`generatePositioningSuggestions`).

### post-tour-brief (`post-tour-brief.prompt.v1.0`)
- **v1.0** (2026-05-01) — Initial versioning baseline. Brief composer
  + follow-up draft composer. Tier-1 content (transcript-derived
  family/financial intelligence).

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
