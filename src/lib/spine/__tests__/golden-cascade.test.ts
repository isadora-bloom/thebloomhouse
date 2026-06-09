/**
 * Mock-driven golden subset — the CI gate the GC-5 regression needed.
 *
 * The full golden harness (tests/golden/run-golden-cases.ts) runs the REAL
 * cascade against a TEST-BRANCH Supabase, so it is NOT in CI — and that is
 * exactly why a matcher regression (GC-5: an over-broad corroboration veto)
 * shipped to prod undetected on 2026-06-04. This test closes that gap: it runs
 * the SAME cases.json through the REAL `linkSignal` against an in-memory
 * Supabase fake, so a matching / Tier-1.5-veto / tier-routing /
 * partner-reconciliation regression now fails `npx vitest run`.
 *
 * What is real here: the matcher (scoreCandidate), the contradiction guard
 * (hardContradiction), tier routing (applyTierRouting), and the two RPCs'
 * semantics (lock_and_mint_couple, merge_couples — re-implemented in the fake
 * to match migrations 359 + 379). What is stubbed: the LLM judge + its context
 * builder (no network — deterministic budget-exhausted, leaving the matcher
 * tier intact), and the progression / resurrection side-effects (orthogonal to
 * the identity decision; they have their own CI tests). See golden-mock-supabase.ts.
 *
 * Only `surface: "spine"` assertions run (the same ones the live harness
 * evaluates today). `legacy` / `pending:*` assertions stay the full harness's
 * job and are reported, never silently passed. Catalog is shared + additive —
 * a new GC case with a spine assertion is automatically gated here.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockSupabase } from './golden-mock-supabase'

// ── stub the orthogonal side-modules (no network, deterministic) ───────────
vi.mock('@/lib/services/identity/llm-judge', () => ({
  LLM_JUDGE_PROMPT_VERSION: 'test',
  newJudgeBudget: () => ({}),
  // budget_exhausted leaves the matcher tier untouched — the identity
  // decision under test is the matcher + the deterministic guard, not the LLM.
  judgeCandidate: async () => ({ kind: 'budget_exhausted', scope: 'run' }),
}))
vi.mock('@/lib/services/identity/judge-context', () => ({
  buildJudgeContext: async () => ({}),
}))
vi.mock('@/lib/services/identity/progression', () => ({
  recordProgressionIfEligible: async () => undefined,
  recordFragmentMatchReturned: async () => undefined,
  progressionEventTypeFor: () => null,
}))
vi.mock('@/lib/services/identity/resurrection', () => ({
  maybeResurrectGhost: async () => undefined,
  rejectResurrection: async () => undefined,
}))

// ── case catalog (shared with the live harness) ────────────────────────────
interface Assertion {
  check: string
  surface: string
  [k: string]: unknown
}
interface Signal {
  channel: string
  action: string
  at: string
  name?: string
  partnerName?: string
  identifiers?: { kind: string; value: string; reliability?: string }[]
  body?: string
  wedding_id?: string
  wedding_date?: string
  lead_source_field?: string
  direction?: string
  repeat?: number
}
interface Case {
  id: string
  title: string
  signals: Signal[]
  assert: Assertion[]
}

const CASES_PATH = join(process.cwd(), 'tests', 'golden', 'cases.json')
const { cases } = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as { cases: Case[] }

// ── the spine snapshot + assertion engine (mirrors run-golden-cases.ts) ────
interface LinkOutcome {
  action: string
  matched_couple_id: string | null
  touchpoint_id: string | null
  candidate_match_queued: boolean
}
interface SpineState {
  link_outcomes: LinkOutcome[]
  couples: { id: string; lifecycle_state: string }[]
  touchpoints: { channel: string; action_type: string; couple_id: string | null }[]
  open_candidate_matches: number
}

async function materialize(c: Case): Promise<SpineState> {
  const { client, db } = createMockSupabase()
  const { linkSignal } = await import('@/lib/services/identity/forwards-linker')
  // Distinct venue per case so the module-level couples cache can't bleed
  // (bypassCache: true is also set, belt-and-braces, exactly as the harness).
  const venueId = `00000000-0000-4000-9000-${c.id.replace(/[^a-z0-9]/gi, '').slice(0, 12).padStart(12, '0')}`

  const link_outcomes: LinkOutcome[] = []
  for (const [sigIdx, s] of c.signals.entries()) {
    for (let i = 0; i < (s.repeat ?? 1); i++) {
      const primary = (s.identifiers ?? [])[0]
      const r = await linkSignal({
        supabase: client,
        venueId,
        bypassCache: true,
        signal: {
          external_id: `${c.id}-s${sigIdx}-${s.channel}-${s.action}-${i}`,
          channel: s.channel,
          action_type: s.action,
          occurred_at: s.at,
          signal_tier: s.direction === 'outbound' ? 'medium' : 'high',
          identity_hint: s.name ?? null,
          primary_name: s.name ?? null,
          partner_name: s.partnerName ?? null,
          primary_email: primary?.kind === 'email' ? primary.value : null,
          primary_phone: primary?.kind === 'phone' ? primary.value : null,
          wedding_date: s.wedding_date ?? null,
          legacy_wedding_id: s.wedding_id ?? null,
          author_class: 'couple',
          raw_payload: { direction: s.direction ?? 'inbound', body: s.body, lead_source_field: s.lead_source_field },
        } as Parameters<typeof linkSignal>[0]['signal'],
      })
      link_outcomes.push({
        action: r.action,
        matched_couple_id: r.matched_couple_id,
        touchpoint_id: r.touchpoint_id,
        candidate_match_queued: r.candidate_match_queued,
      })
    }
  }

  // Same reads the live harness snapshots — merged (tombstoned) couples excluded.
  const couples = db.tables.couples
    .filter((r) => r.venue_id === venueId && (r.merged_into_id ?? null) === null)
    .map((r) => ({ id: r.id as string, lifecycle_state: r.lifecycle_state as string }))
  const touchpoints = db.tables.touchpoints
    .filter((r) => r.venue_id === venueId)
    .map((r) => ({ channel: r.channel as string, action_type: r.action_type as string, couple_id: (r.couple_id as string) ?? null }))
  const open_candidate_matches = db.tables.candidate_matches.filter(
    (r) => r.venue_id === venueId && (r.resolution ?? null) === null,
  ).length

  return { link_outcomes, couples, touchpoints, open_candidate_matches }
}

type Verdict = { ok: boolean; msg?: string }
function evalSpineAssertion(a: Assertion, s: SpineState): Verdict {
  const actions = s.link_outcomes.map((o) => o.action)
  switch (a.check) {
    case 'couple_count':
      return { ok: s.couples.length === a.eq, msg: `couple_count ${s.couples.length} ≠ ${a.eq}` }
    case 'couple_count_min':
      return { ok: s.couples.length >= (a.min as number), msg: `couple_count ${s.couples.length} < ${a.min}` }
    case 'link_actions_eq':
      return { ok: JSON.stringify(actions) === JSON.stringify(a.eq), msg: `link actions [${actions}] ≠ [${a.eq}]` }
    case 'link_actions_include':
      return { ok: (a.eq as string[]).every((x) => actions.includes(x)), msg: `link actions [${actions}] missing ${a.eq}` }
    case 'link_action_absent':
      return { ok: !actions.includes(a.eq as string), msg: `link action "${a.eq}" should not occur (got [${actions}])` }
    case 'lifecycle_state_any':
      return { ok: s.couples.some((c) => c.lifecycle_state === a.eq), msg: `no couple with lifecycle_state=${a.eq}` }
    case 'review_queue_open_min':
      return { ok: s.open_candidate_matches >= (a.min as number), msg: `open candidate_matches ${s.open_candidate_matches} < ${a.min}` }
    case 'touchpoint_count_min':
      return { ok: s.touchpoints.length >= (a.min as number), msg: `touchpoints ${s.touchpoints.length} < ${a.min}` }
    default:
      return { ok: false, msg: `unknown spine check "${a.check}"` }
  }
}

// ── one vitest case per golden case (spine assertions only) ────────────────
describe('golden cases — mock-driven spine subset (CI gate for matcher regressions)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  for (const c of cases) {
    const spineAsserts = c.assert.filter((a) => a.surface === 'spine')
    if (spineAsserts.length === 0) {
      it.skip(`${c.id} ${c.title} — no spine assertions (full harness only)`, () => {})
      continue
    }
    it(`${c.id} ${c.title} — ${spineAsserts.length} spine assertion(s)`, async () => {
      const state = await materialize(c)
      for (const a of spineAsserts) {
        const v = evalSpineAssertion(a, state)
        expect(v.ok, v.msg).toBe(true)
      }
    })
  }
})
