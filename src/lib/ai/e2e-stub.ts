/**
 * Canned model responses for the end-to-end suite.
 *
 * E2E-PLAN.md: "Model calls: a stub. `src/lib/ai/client.ts` has no fixture
 * mode today. Add `AI_E2E_STUB=1` that returns canned, schema-valid
 * responses keyed by prompt version, logs the cost row as usual, and
 * refuses to run when `VERCEL_ENV=production`."
 *
 * The contract, in full:
 *
 *   - Active only when `AI_E2E_STUB=1` AND `VERCEL_ENV !== 'production'`.
 *     There is no flag combination that turns it on in production.
 *   - `callAI`, `callAIJson` and `callAIVision` answer from
 *     `e2e/fixtures/ai/<promptVersion>.json` — the same `promptVersion`
 *     the caller already passes for the `api_costs.prompt_version`
 *     column. No prompt version, no key: those calls get the generic
 *     answer and a log line saying so.
 *   - A missing fixture is never a failure. The caller gets a generic,
 *     schema-valid empty answer (`{}` for a JSON call, one short line of
 *     prose otherwise) and a `ai_e2e_stub_missing_fixture` line naming
 *     the key, so the run tells you which fixtures to record rather than
 *     dying at the first uncovered prompt.
 *   - The cost row is still written, with `model: 'stub'` and zero
 *     tokens, so a journey that asserts "this action logged a model call"
 *     keeps asserting something true.
 *
 * Recording a fixture (`AI_E2E_RECORD=1`): the call goes to the real
 * model as normal and the answer is written to the fixture file
 * afterwards. Stub and record are mutually exclusive — the stub
 * short-circuits before any provider is reached, so with both set you
 * record nothing. Recording is also refused in production.
 *
 * See e2e/fixtures/ai/README.md for the operator steps.
 */

/** The `model` column value every stubbed call logs. */
export const STUB_MODEL = 'stub'

/** Fixture directory, relative to the repository root. */
export const FIXTURE_DIR = 'e2e/fixtures/ai'

/**
 * The suffix `callAIJson` appends to the system prompt. Exported so the
 * stub can tell a JSON call from a prose one without a new option on
 * CallAIOptions (a private flag would have to be threaded through every
 * caller; this reads the request we already send).
 */
export const JSON_INSTRUCTION =
  '\n\nRespond with valid JSON only. No markdown, no code blocks, no explanation.'

/** Generic answer for a prose call with no fixture. */
export const GENERIC_TEXT_ANSWER =
  'This is a stubbed answer from the end-to-end harness. No model was called.'

/** Generic answer for a JSON call with no fixture: a valid, empty object. */
export const GENERIC_JSON_ANSWER = '{}'

export interface AiFixture {
  /** The prompt version this fixture answers for. */
  promptVersion?: string
  /** The task type the recording came from, for the reader's benefit. */
  taskType?: string
  /** The model that produced it, when recorded. */
  model?: string
  /** ISO timestamp of the recording. */
  recordedAt?: string
  /** The answer text. For a JSON call this is the JSON document itself. */
  text: string
}

function vercelEnv(): string {
  return process.env.VERCEL_ENV ?? ''
}

/** True when the stub may answer. Production is refused outright. */
export function isStubActive(): boolean {
  if (vercelEnv() === 'production') return false
  return process.env.AI_E2E_STUB === '1'
}

/** True when a real call should be written to a fixture afterwards. */
export function isRecordActive(): boolean {
  if (vercelEnv() === 'production') return false
  if (isStubActive()) return false
  return process.env.AI_E2E_RECORD === '1'
}

/**
 * Fixture file name for a prompt version. A prompt version is a
 * caller-supplied string that lands on the filesystem, so it is reduced
 * to a safe basename: anything outside `[A-Za-z0-9._-]` becomes `_`, and
 * a leading dot is dropped so nothing can write a dotfile or escape the
 * directory.
 */
export function fixtureFileName(promptVersion: string): string {
  const safe = promptVersion.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return `${safe || 'unkeyed'}.json`
}

let fsMod: typeof import('node:fs') | null = null
let pathMod: typeof import('node:path') | null = null

// Server-only, loaded on first use. The ignore comments matter: this
// module is reachable from client components (canonical.ts is imported
// by several 'use client' files and it imports ai/tools, which imports
// this), and a bundler that follows these imports for the browser bundle
// fails on the `node:` scheme. `next build --webpack` did exactly that on
// 2026-09-15 ("Reading from node:path is not handled by plugins"). Turbopack
// tolerated it, which is why the Vercel build never saw it. The stub is
// inert in the browser regardless: isStubActive reads a server env var.
async function nodeFs() {
  if (!fsMod) fsMod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:fs')
  return fsMod
}

async function nodePath() {
  if (!pathMod) pathMod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:path')
  return pathMod
}

async function fixturePath(promptVersion: string): Promise<string> {
  const path = await nodePath()
  return path.join(process.cwd(), FIXTURE_DIR, fixtureFileName(promptVersion))
}

const cache = new Map<string, AiFixture | null>()

/**
 * Read a fixture. Returns null when there is no key, no file, or the file
 * is unreadable — in every one of those cases the caller falls back to
 * the generic answer and logs which key was missing.
 */
export async function readFixture(promptVersion: string | undefined): Promise<AiFixture | null> {
  if (!promptVersion) return null
  if (cache.has(promptVersion)) return cache.get(promptVersion) ?? null
  let result: AiFixture | null = null
  try {
    const fs = await nodeFs()
    const file = await fixturePath(promptVersion)
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AiFixture
      if (parsed && typeof parsed.text === 'string') result = parsed
    }
  } catch {
    result = null
  }
  cache.set(promptVersion, result)
  return result
}

/** Test-only: forget what has been read so a new fixture file is picked up. */
export function resetFixtureCache(): void {
  cache.clear()
}

export interface StubAnswer {
  text: string
  /** Where the text came from, for the log line. */
  source: 'fixture' | 'generic'
  /** The fixture key that was looked for, or null when the call had none. */
  key: string | null
}

/**
 * The stubbed answer for one call. `systemPrompt` is only used to tell a
 * JSON call from a prose one when there is no fixture.
 */
export async function stubAnswer(opts: {
  promptVersion?: string
  systemPrompt?: string
  taskType?: string
}): Promise<StubAnswer> {
  const key = opts.promptVersion ?? null
  const fixture = await readFixture(opts.promptVersion)
  if (fixture) return { text: fixture.text, source: 'fixture', key }

  const wantsJson = (opts.systemPrompt ?? '').includes(JSON_INSTRUCTION)
  console.warn(
    JSON.stringify({
      event: 'ai_e2e_stub_missing_fixture',
      promptVersion: key,
      taskType: opts.taskType ?? null,
      file: key ? `${FIXTURE_DIR}/${fixtureFileName(key)}` : null,
      reason: key ? 'no fixture file' : 'caller passed no promptVersion',
      answered: wantsJson ? 'generic empty object' : 'generic sentence',
    })
  )
  return {
    text: wantsJson ? GENERIC_JSON_ANSWER : GENERIC_TEXT_ANSWER,
    source: 'generic',
    key,
  }
}

/**
 * Write a real answer to its fixture file. Called after a live call when
 * `AI_E2E_RECORD=1`. Never throws: a recording failure must not break the
 * call that produced the answer.
 */
export async function recordFixture(opts: {
  promptVersion?: string
  taskType?: string
  model?: string
  text: string
}): Promise<void> {
  if (!isRecordActive()) return
  if (!opts.promptVersion) {
    console.warn(
      JSON.stringify({
        event: 'ai_e2e_record_skipped',
        reason: 'caller passed no promptVersion, so the answer has no key',
        taskType: opts.taskType ?? null,
      })
    )
    return
  }
  try {
    const fs = await nodeFs()
    const path = await nodePath()
    const dir = path.join(process.cwd(), FIXTURE_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, fixtureFileName(opts.promptVersion))
    const body: AiFixture = {
      promptVersion: opts.promptVersion,
      taskType: opts.taskType,
      model: opts.model,
      recordedAt: new Date().toISOString(),
      text: opts.text,
    }
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    cache.delete(opts.promptVersion)
    console.log(
      JSON.stringify({ event: 'ai_e2e_fixture_recorded', promptVersion: opts.promptVersion, file })
    )
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'ai_e2e_record_failed',
        promptVersion: opts.promptVersion,
        error: String(err),
      })
    )
  }
}
