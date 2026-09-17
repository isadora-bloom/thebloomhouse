/**
 * The couple never sees the venue's commercial position.
 * 2026-09-14 security review, item 3.
 *
 * `buildSageIntelligenceContext` serves two callers with one function. The
 * email brains pass a personId, because they are drafting to a known
 * person. Couple-portal chat passes nothing, because there is no person to
 * pass. Three blocks read the wrong side of that line: the demand outlook
 * (a market score out of 100), the trend deviations (which search terms are
 * moving and by how much) and the unacknowledged anomaly alerts (the
 * venue's own written explanation of what has gone wrong). All three
 * reached the couple prompt, guarded by the sentence "use naturally, never
 * quote raw numbers to couples" at the top of the block.
 *
 * The gate is now the same personId check the journey narrative already
 * used. These tests assert the couple path does not assemble the blocks at
 * all, and that the operator path still does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ALERT_EXPLANATION = 'ANOMALY-SENTINEL: inquiries down 40% since the access road closed'

const queriedTables: string[] = []

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      queriedTables.push(table)
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      builder.select = chain
      builder.eq = chain
      builder.in = chain
      builder.gte = chain
      builder.lte = chain
      builder.is = chain
      builder.limit = async () => {
        if (table === 'anomaly_alerts') {
          return {
            data: [
              {
                alert_type: 'volume',
                metric_name: 'inquiry_count',
                severity: 'critical',
                ai_explanation: ALERT_EXPLANATION,
              },
            ],
          }
        }
        return { data: [] }
      }
      builder.order = (_col: string, _opts?: unknown) => builder
      builder.single = async () => ({ data: null, error: new Error('none') })
      builder.maybeSingle = async () => ({ data: null })
      // Terminal await on the builder itself (the weather query ends on
      // .order and is awaited directly).
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [] })
      return builder
    },
  }),
}))

vi.mock('@/lib/services/intel/fred-demand', () => ({
  getLatestIndicators: async () => ({ cpi: 310.4 }),
  calculateDemandScore: () => ({ score: 71, outlook: 'caution' as const }),
}))

vi.mock('@/lib/services/intel/trends', () => ({
  detectTrendDeviations: async () => [
    { term: 'barn wedding', direction: 'down' as const, changePercent: -31, category: 'style' },
  ],
}))

vi.mock('@/lib/intel/readers/prior-touches', () => ({
  loadCouplePriorTouchesForPerson: async () => null,
  narrateCoupleTouches: () => '',
  humanChannel: (s: string) => s,
}))

vi.mock('@/lib/services/brain/journey-narrative', () => ({
  fetchCachedNarrative: async () => null,
}))

vi.mock('@/lib/services/learning', () => ({
  getLearningContext: async () => ({
    editPatterns: [],
    rejectionReasons: [],
    goodExamples: [],
  }),
}))

const VENUE = '44444444-4444-4444-8444-444444444444'
const PERSON = '55555555-5555-4555-8555-555555555555'

beforeEach(() => {
  queriedTables.length = 0
})

async function build(personId?: string | null) {
  const { buildSageIntelligenceContext } = await import(
    '@/lib/services/intel/sage-intelligence'
  )
  return buildSageIntelligenceContext(VENUE, personId)
}

describe('buildSageIntelligenceContext', () => {
  it('gives the couple path no demand outlook', async () => {
    const ctx = await build()
    expect(ctx).not.toContain('DEMAND OUTLOOK')
    expect(ctx).not.toContain('71/100')
    expect(ctx).not.toContain('may be cooling')
  })

  it('gives the couple path no trend deviations', async () => {
    const ctx = await build()
    expect(ctx).not.toContain('TREND HIGHLIGHTS')
    expect(ctx).not.toContain('barn wedding')
  })

  it('gives the couple path no anomaly alerts, and does not even read the table', async () => {
    const ctx = await build()
    expect(ctx).not.toContain('ACTIVE ALERTS')
    expect(ctx).not.toContain(ALERT_EXPLANATION)
    expect(queriedTables).not.toContain('anomaly_alerts')
  })

  it('still gives the operator path all three', async () => {
    const ctx = await build(PERSON)
    expect(ctx).toContain('DEMAND OUTLOOK')
    expect(ctx).toContain('TREND HIGHLIGHTS')
    expect(ctx).toContain('ACTIVE ALERTS')
    expect(ctx).toContain(ALERT_EXPLANATION)
  })
})
