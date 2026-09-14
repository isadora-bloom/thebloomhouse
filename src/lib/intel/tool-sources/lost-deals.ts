/**
 * Why couples say no after touring. NOVEMBER-PLAN.md wave 2, W14. Battery Q40.
 *
 * Reads `lost_deals` filtered to lost_at_stage='tour' — the same canonical
 * read src/lib/services/brain/intel-brain.ts already uses for this exact
 * fact ("lost_deals.reason_category is the canonical 'why the deal died'
 * signal", its words). weddings.lost_reason is free text on the wedding
 * itself and not a bounded enum; lost_deals.reason_category is the
 * deal-level structured record (migration 009's 9-bucket CHECK), so it is
 * the honest source for a *distribution* rather than 500 near-unique
 * strings. This is distinct from tours.cancellation_reason (why a TOUR
 * was cancelled, classified by cancellation-classifier.ts) — that is a
 * different fact: the tour never happened, but the lead can still book.
 * This tool is about deals that reached or passed the tour and then died.
 *
 * Returns no couple identity at all: no wedding_id, no name, not even a
 * count broken down small enough to re-identify one couple by elimination
 * beyond what the reason distribution itself already reveals.
 */
import type { IntelToolSource, ToolSourceDeps } from './types'
import { insufficient } from './types'

/** Below this many lost-after-tour deals, a "top reasons" read is noise. */
const MIN_DEALS = 5
const DEFAULT_LOOKBACK_DAYS = 365
const TOP_N_REASONS = 3
const EXAMPLE_MAX_CHARS = 160

/** Mirrors the CHECK constraint on lost_deals.reason_category, migration 009. */
const REASON_LABELS: Record<string, string> = {
  no_response: 'went quiet, stopped responding',
  pricing: 'price',
  competitor: 'chose a competitor venue',
  date_unavailable: 'date was not available',
  ghosted: 'ghosted after the tour',
  changed_plans: 'changed their plans',
  venue_mismatch: 'venue was not the right fit',
  budget_change: 'budget changed',
  other: 'other',
}

interface LostDealRow {
  reason_category: string
  reason_detail: string | null
}

/** Cheap, not a full PII scrubber: reason_detail is operator-written
 *  shorthand ("wanted a lower price", "booked at a barn venue"), not raw
 *  couple correspondence. Strips anything that reads as a First Last name
 *  and clamps length so a stray name never rides along in the quote. */
function anonymise(text: string): string {
  const stripped = text.replace(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, '[name]')
  const trimmed = stripped.trim()
  if (trimmed.length <= EXAMPLE_MAX_CHARS) return trimmed
  return trimmed.slice(0, EXAMPLE_MAX_CHARS - 1).trimEnd() + '…'
}

function parseLookbackDays(args: Record<string, unknown>): number {
  const raw = args.lookback_days
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw)
  }
  return DEFAULT_LOOKBACK_DAYS
}

async function run(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const lookbackDays = parseLookbackDays(args)
  const since = new Date(`${deps.today.slice(0, 10)}T00:00:00Z`)
  since.setUTCDate(since.getUTCDate() - lookbackDays)

  const { data, error } = await deps.supabase
    .from('lost_deals')
    .select('reason_category, reason_detail')
    .eq('venue_id', venueId)
    .eq('lost_at_stage', 'tour')
    .not('reason_category', 'is', null)
    .gte('lost_at', since.toISOString())
    .limit(1000)

  if (error) {
    return { n: 0, enoughData: false, reason: `lost_deals read failed: ${error.message}` }
  }

  const rows = (data ?? []) as LostDealRow[]
  const n = rows.length

  if (n < MIN_DEALS) {
    return {
      ...insufficient(
        n,
        `fewer than ${MIN_DEALS} lost-after-tour deals recorded with a reason in the last ${lookbackDays} days`,
      ),
      lookbackDays,
      distribution: [],
      topReasons: [],
    }
  }

  const byReason = new Map<string, { n: number; examples: string[] }>()
  for (const r of rows) {
    const key = r.reason_category
    const e = byReason.get(key) ?? { n: 0, examples: [] }
    e.n++
    if (r.reason_detail && r.reason_detail.trim()) {
      e.examples.push(anonymise(r.reason_detail))
    }
    byReason.set(key, e)
  }

  const ranked = Array.from(byReason.entries()).sort((a, b) => b[1].n - a[1].n)

  const distribution = ranked.map(([reason, e]) => ({
    reason: REASON_LABELS[reason] ?? reason,
    n: e.n,
    pct: Math.round((e.n / n) * 1000) / 10,
  }))

  const topReasons = ranked.slice(0, TOP_N_REASONS).map(([reason, e]) => ({
    reason: REASON_LABELS[reason] ?? reason,
    n: e.n,
    example: e.examples[0] ?? null,
  }))

  return {
    n,
    enoughData: true,
    lookbackDays,
    distribution,
    topReasons,
  }
}

export const lostDealsToolSource: IntelToolSource = {
  tool: {
    name: 'get_lost_deal_reasons',
    description:
      'Why couples who toured this venue ultimately said no: the distribution of recorded lost-deal ' +
      'reasons at the tour stage, with one short anonymised example quote for each of the top three ' +
      'reasons. Never returns a couple name, id, or anything that could identify one couple. Use this ' +
      'for "why do we lose deals", "why do couples say no after a tour", or reason-for-loss questions. ' +
      'This is a different fact from a tour being cancelled (the tour never happened but the lead can ' +
      'still book): this is a deal that reached or passed the tour and then died.',
    input_schema: {
      type: 'object',
      properties: {
        lookback_days: {
          type: 'number',
          description: 'How many days back from today to look. Defaults to 365.',
        },
      },
      additionalProperties: false,
    },
  },
  subjects: [
    'why couples say no after a tour',
    'lost deal reasons',
    'reasons deals fall through after touring',
  ],
  batteryQuestions: ['40'],
  // `example` is lost_deals.reason_detail: free text an operator typed,
  // anonymised but still somebody's sentence. `reason` is not listed: it is
  // a REASON_LABELS value mapped off a CHECK-constrained enum, so it is this
  // product's own vocabulary, not ingested prose.
  freeTextFields: ['example'],
  run,
}
