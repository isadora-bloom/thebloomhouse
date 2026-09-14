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

## Rules for what lives here

- No API keys, no tokens, no service-role JWTs. The secrets guard scans
  every tracked file and this folder is not allow-listed.
- No real couples, no real venues that are not the demo set. Use the
  demo names the seed already uses.
- Keep the answers short. A fixture is a fixed point for an assertion,
  not a transcript.
