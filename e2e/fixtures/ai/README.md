# Canned model answers for the E2E suite

One file per prompt version. `src/lib/ai/e2e-stub.ts` reads them; nothing
else does.

## Why

The end-to-end suite runs the whole product, and most of the product asks
a model something. Real calls make the suite slow, expensive and
non-deterministic: the same journey gets a different sentence every night
and an assertion on the wording is a coin toss. So the harness runs with
`AI_E2E_STUB=1` and the model answers from this folder.

## The contract

- The stub is active only when `AI_E2E_STUB=1` **and** `VERCEL_ENV` is not
  `production`. There is no combination of flags that turns it on in
  production.
- `callAI`, `callAIJson` and `callAIVision` look for
  `<promptVersion>.json`, keyed on the `promptVersion` the caller already
  passes for `api_costs.prompt_version`.
- The cost row is still written, with `model: 'stub'` and zero tokens. A
  journey that asserts "this action logged a model call" keeps working.
- No fixture, or no `promptVersion` at all, is not a failure. The caller
  gets a generic answer — `{}` for a JSON call, one short sentence
  otherwise — and the run logs `ai_e2e_stub_missing_fixture` naming the
  key it wanted. Read those lines after a run: they are the list of
  fixtures worth recording.

## File shape

```json
{
  "promptVersion": "inquiry-brain.prompt.v1.0",
  "taskType": "inquiry-brain",
  "model": "claude-sonnet-4-6",
  "recordedAt": "2026-09-14T00:00:00.000Z",
  "text": "the answer exactly as the model returned it"
}
```

`text` is the raw answer. For a JSON call that means the JSON document
itself, as a string — the same thing `callAIJson` would have parsed.

The file name is derived from the prompt version: anything outside
`[A-Za-z0-9._-]` becomes `_`.

## Recording one

Recording makes a real, billed call. Do it deliberately, against a
non-production environment, with the branch env loaded:

```
# 1. Point at the test branch and give it a real key.
#    .env.test needs ANTHROPIC_API_KEY for this and only this.
# 2. Run the one thing whose prompt you want to capture, with:
AI_E2E_RECORD=1 AI_E2E_STUB=0 npx tsx scripts/<whatever-calls-it>.ts
```

The call goes to the model as normal; the answer lands here afterwards.
Rules the record path enforces:

- Refused when `VERCEL_ENV=production`.
- Refused when `AI_E2E_STUB=1` — the stub short-circuits before any
  provider, so with both set you would record nothing. They are mutually
  exclusive on purpose.
- A call with no `promptVersion` cannot be keyed, so it logs
  `ai_e2e_record_skipped` and writes nothing. If you want a fixture for
  that prompt, give the call site a prompt version first; it should have
  had one anyway, for the cost audit.

Then read the file before committing it. A recorded answer can carry
whatever was in the prompt — a couple's name, an email address, a phone
number. Edit those out. `npm run check:no-secrets` will catch a key; it
will not catch a real person.

## The recording list

Every prompt version journeys 26 to 32 can reach, traced from the route
handler through the service to the `callAI` / `callAIJson` / `callAIVision`
call. Grep `promptVersion` and `BRAIN_PROMPT_VERSION` if you want to
re-derive it.

`placeholder` means a schema-valid file is committed with
`"recordedAt": null` so the stub answers with the right SHAPE before
anyone has recorded the right WORDS. Replace them; do not assert on their
prose.

| Prompt version | Journey | Call | Shape | State |
|---|---|---|---|---|
| `couple-chat.prompt.v2.1` | 27 | `callAI` | prose | placeholder |
| `couple-file-extraction.prompt.v1` | 27 (only on an attachment) | `callAIVision` | prose | placeholder |
| `planning-extraction.prompt.v1.0` | 27 (every Sage turn) | `callAIJson` | **array** of `{category, content, confidence}` | placeholder (`[]`) |
| `escalation-detector.prompt.v2` | 27 (every Sage turn) | `callAI`, validated | `{escalation_requested: boolean, confidence_0_100?, reasoning?}` | placeholder |
| `seating-import-col-detect-v1` | 27 (only on a seating import) | `callAIJson` | `{table, seat, name, relationship, notes, allergies, table_notes, rsvp}`, 0-based indices or null | placeholder |
| `reviews.paste.v1` | 28 | `callAIJson` | `{reviews: [{reviewer_name, rating, body, review_date, source, title}]}` | placeholder |
| `review-language.prompt.v1.0` | 28 (fire-and-forget after import) | `callAIJson` | `{phrases: [{phrase, theme, sentiment}]}` | placeholder |
| `couple-sage-preview.prompt.v1` | 32, and §29's rate-limit test | `callAI` | prose | placeholder |
| `couple-onboarding-test.prompt.v1` | 30 (the test-draft step) | `callAI` | prose | placeholder |
| `crm-import.ai-mapped.prompt.v1.0` | 26 / 30, only if the `ai_mapped` adapter is chosen | `callAIJson` | `{mappings: [{csv_header, bloom_field, confidence, reason}]}` | placeholder (empty) |
| `intel-brain.prompt.v2.1` | 28, only with `NLQ_LEGACY=1` | `callAI` | prose | placeholder |

Reached by journeys 26 and 30 only through the cron work the import
enqueues, so they matter if the run drives the cron and not otherwise. No
placeholder is committed, because a wrong-shaped guess is worse than the
generic answer: `identity-reconstruction.prompt.v2`,
`candidate-ai-adjudicator.prompt.v1.1`, `identity.phase-b.llm-judge.v1`,
`profile-enrichment.v1`, `channel-role-classifier.prompt.v2`,
`inquiry-intent-judge.prompt.v2`, `lifecycle.signal.v1.0`.

Journeys that reach no model at all: 31 (`/settings/integrations` and
every page under it has zero `callAI` call sites), and the deterministic
half of 26 — the Dubsado, generic-CSV, tour-scheduler and web-form
adapters are parsers, not prompts.

### Three traps

**1. `/intel/nlq` is not stubbed at all.** The live Ask Your Data path is
`askIntel` → `callAITools` (`src/lib/ai/tools.ts`), and the stub hook
exists only in `callAI`, `callAIJson` and `callAIVision`
(`src/lib/ai/client.ts`). So `ask-intel.tools.prompt.v1.1` cannot be
fixtured, and a question asked under `AI_E2E_STUB=1` still makes a real,
billed, multi-turn tool-calling request. §28 tags those two tests
`@live-model` and skips them unless `E2E_LIVE_MODEL=1`. The fix is a
`isStubActive()` branch in `callAITools`; until then this is a hole in the
stub, not a hole in the tests.

**2. Some constants are dead as fixture keys.** `buildCoordinatorPrompt`
returns a version from its own `PROMPT_VERSIONS` map, and THAT is what
reaches the call and the filename — not the exported
`*_PROMPT_VERSION` constant next to the call site, which in eleven cases
is a version ahead. Name a fixture after the map value. The same applies
in reverse to `re-engagement-drafter`, where the call site's own constant
(`v1.1`) wins over the map entry (`v2.0`).

**3. One key, two shapes.** `data-detection.prompt.v1.0`,
`couple-contract.prompt.v1` and `portal-quick-add.prompt.v1.0` are each
passed by two or more callers that parse incompatible answers (an object
and an array, or a JSON call and a prose one). One file cannot satisfy
both, so none is committed for them: the generic empty answer fails more
honestly than a fixture that is right for one caller and wrong for the
other. Splitting the key is the real fix.

A file name is derived from the version with everything outside
`[A-Za-z0-9._-]` replaced by `_`, so
`calibration-narrator/v1@2026-05-11` would be
`calibration-narrator_v1_2026-05-11.json`.

## Rules for what lives here

- No API keys, no tokens, no service-role JWTs. The secrets guard scans
  every tracked file and this folder is not allow-listed.
- No real couples, no real venues that are not the demo set. Use the
  demo names the seed already uses.
- Keep the answers short. A fixture is a fixed point for an assertion,
  not a transcript.
