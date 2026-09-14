/**
 * The AI stub's contract (E2E-PLAN.md W69). No model is called here and
 * none can be: the point of these tests is the switch, the key and the
 * fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isStubActive,
  isRecordActive,
  fixtureFileName,
  stubAnswer,
  resetFixtureCache,
  GENERIC_JSON_ANSWER,
  GENERIC_TEXT_ANSWER,
  JSON_INSTRUCTION,
} from '../e2e-stub'

const saved = { ...process.env }

beforeEach(() => {
  resetFixtureCache()
  delete process.env.AI_E2E_STUB
  delete process.env.AI_E2E_RECORD
  delete process.env.VERCEL_ENV
})

afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

describe('the switch', () => {
  it('is off by default', () => {
    expect(isStubActive()).toBe(false)
    expect(isRecordActive()).toBe(false)
  })

  it('turns on with AI_E2E_STUB=1', () => {
    process.env.AI_E2E_STUB = '1'
    expect(isStubActive()).toBe(true)
  })

  it('refuses to activate in production, whatever the flag says', () => {
    process.env.AI_E2E_STUB = '1'
    process.env.AI_E2E_RECORD = '1'
    process.env.VERCEL_ENV = 'production'
    expect(isStubActive()).toBe(false)
    expect(isRecordActive()).toBe(false)
  })

  it('records only when the stub is off — the two are mutually exclusive', () => {
    process.env.AI_E2E_RECORD = '1'
    expect(isRecordActive()).toBe(true)
    process.env.AI_E2E_STUB = '1'
    expect(isRecordActive()).toBe(false)
  })

  it('ignores anything other than an exact 1', () => {
    process.env.AI_E2E_STUB = 'true'
    expect(isStubActive()).toBe(false)
  })
})

describe('fixture keys', () => {
  it('keeps a well-formed prompt version as-is', () => {
    expect(fixtureFileName('inquiry-brain.prompt.v1.0')).toBe('inquiry-brain.prompt.v1.0.json')
  })

  it('cannot escape the fixture directory', () => {
    expect(fixtureFileName('../../etc/passwd')).toBe('_.._etc_passwd.json')
    expect(fixtureFileName('..')).toBe('unkeyed.json')
    expect(fixtureFileName('a/b\\c')).toBe('a_b_c.json')
  })
})

describe('the fallback', () => {
  it('answers a JSON call with a valid empty object when no fixture exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = await stubAnswer({
      promptVersion: 'does-not-exist.v9',
      systemPrompt: `anything${JSON_INSTRUCTION}`,
      taskType: 'test',
    })
    expect(answer.source).toBe('generic')
    expect(answer.text).toBe(GENERIC_JSON_ANSWER)
    expect(() => JSON.parse(answer.text)).not.toThrow()
    // and it says which key was missing
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('does-not-exist.v9')
  })

  it('answers a prose call with a sentence and names the missing key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = await stubAnswer({ promptVersion: 'also-missing.v1', systemPrompt: 'plain' })
    expect(answer.text).toBe(GENERIC_TEXT_ANSWER)
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain(
      'ai_e2e_stub_missing_fixture'
    )
  })

  it('logs the reason when the caller passed no prompt version at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = await stubAnswer({ systemPrompt: 'plain', taskType: 'unkeyed' })
    expect(answer.key).toBeNull()
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('no promptVersion')
  })
})
