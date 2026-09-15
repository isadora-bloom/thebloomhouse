/**
 * Unit tests for validate-plan (W72). Fixture schema facts, hand-built
 * plans — this suite never touches the real migrations tree; that
 * coverage lives in `plan.test.ts`, which validates the actual generated
 * plan against `readSchemaFacts()`.
 */

import { describe, it, expect } from 'vitest'
import { buildSchemaFacts } from '../schema-facts'
import { formatValidationReport, tablesInPlan, validatePlan } from '../validate-plan'
import type { ReseedPlan, ReseedStep } from '../types'

const FACTS = buildSchemaFacts([
  {
    name: '001_x.sql',
    sql: `
      CREATE TABLE IF NOT EXISTS brand_assets (
        id uuid PRIMARY KEY,
        venue_id uuid NOT NULL,
        category text CHECK (category IS NULL OR category IN ('ceremony', 'other'))
      );
      CREATE TABLE IF NOT EXISTS follow_up_sequence_templates (
        id uuid PRIMARY KEY,
        venue_id uuid NOT NULL
      );
    `,
  },
  {
    name: '002_x.sql',
    sql: 'ALTER TABLE follow_up_sequence_templates RENAME TO _archived_follow_up_sequence_templates;',
  },
])

function auxStep(overrides: Partial<ReseedStep> = {}): ReseedStep {
  return {
    kind: 'aux_rows',
    storyKey: 'story-1',
    venueId: 'venue-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    table: 'brand_assets',
    rows: [{ id: '1', venue_id: 'venue-1', category: 'ceremony' }],
    ...overrides,
  }
}

function planWith(steps: ReseedStep[], deletes: ReseedPlan['deletes'] = []): ReseedPlan {
  return {
    seed: 1,
    today: '2026-01-01T00:00:00.000Z',
    venueIds: ['venue-1'],
    preserveWeddingIds: [],
    deletes,
    steps,
    summary: {
      stories: 1,
      signals: 0,
      heatEvents: 0,
      auxRows: steps.reduce((n, s) => n + (s.rows?.length ?? 0), 0),
      byVenue: {},
      byLifecycle: {
        inquiry: 0,
        tour_booked: 0,
        toured: 0,
        booked: 0,
        lost: 0,
        completed: 0,
      },
      byExpectedTier: { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0 },
    },
  }
}

describe('validatePlan', () => {
  it('passes a plan whose tables, columns and values all check out', () => {
    const plan = planWith([auxStep()])
    const result = validatePlan(plan, FACTS)
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('flags an aux_rows step targeting a table renamed away (W72 finding 1)', () => {
    const plan = planWith([
      auxStep({ table: 'follow_up_sequence_templates', rows: [{ id: '1', venue_id: 'venue-1' }] }),
    ])
    const result = validatePlan(plan, FACTS)
    expect(result.pass).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].kind).toBe('missing-table')
    expect(result.findings[0].table).toBe('follow_up_sequence_templates')
  })

  it('flags a delete op against the same phantom table', () => {
    const plan = planWith([], [{ table: 'follow_up_sequence_templates', venueIds: ['venue-1'], why: 'x' }])
    const result = validatePlan(plan, FACTS)
    expect(result.pass).toBe(false)
    expect(result.findings[0].kind).toBe('missing-table')
  })

  it('flags a value outside the CHECK set (W72 findings 2 and 3)', () => {
    const plan = planWith([auxStep({ rows: [{ id: '1', venue_id: 'venue-1', category: 'logo' }] })])
    const result = validatePlan(plan, FACTS)
    expect(result.pass).toBe(false)
    expect(result.findings[0].kind).toBe('check-violation')
    expect(result.findings[0].message).toContain("category = 'logo'")
    expect(result.findings[0].message).toContain('ceremony')
  })

  it('flags a column the migrations do not declare', () => {
    const plan = planWith([
      auxStep({ rows: [{ id: '1', venue_id: 'venue-1', not_a_real_column: 'x' }] }),
    ])
    const result = validatePlan(plan, FACTS)
    expect(result.pass).toBe(false)
    expect(result.findings.some((f) => f.kind === 'undeclared-column' && f.column === 'not_a_real_column')).toBe(
      true,
    )
  })

  it('does not flag an unresolved <wedding:key> / <couple:key> placeholder', () => {
    const plan = planWith([
      auxStep({
        rows: [{ id: '1', venue_id: '<wedding:story-1>', category: 'ceremony' }],
      }),
    ])
    const result = validatePlan(plan, FACTS)
    expect(result.pass).toBe(true)
  })

  it('dedupes identical findings across many rows', () => {
    const plan = planWith([
      auxStep({
        rows: [
          { id: '1', venue_id: 'venue-1', category: 'logo' },
          { id: '2', venue_id: 'venue-1', category: 'logo' },
        ],
      }),
    ])
    const result = validatePlan(plan, FACTS)
    expect(result.findings).toHaveLength(1)
  })
})

describe('formatValidationReport', () => {
  it('prints VALIDATION PASS for a clean result', () => {
    expect(formatValidationReport({ pass: true, findings: [] })).toBe('VALIDATION PASS')
  })

  it('lists every finding on failure', () => {
    const report = formatValidationReport({
      pass: false,
      findings: [{ kind: 'missing-table', table: 't', message: 'oops' }],
    })
    expect(report).toContain('VALIDATION FAIL')
    expect(report).toContain('oops')
  })
})

describe('tablesInPlan', () => {
  it('collects every delete and aux_rows table, deduplicated', () => {
    const plan = planWith(
      [auxStep({ table: 'a' }), auxStep({ table: 'a' }), auxStep({ table: 'b' })],
      [{ table: 'c', venueIds: ['venue-1'], why: 'x' }],
    )
    expect(tablesInPlan(plan).sort()).toEqual(['a', 'b', 'c'])
  })
})
