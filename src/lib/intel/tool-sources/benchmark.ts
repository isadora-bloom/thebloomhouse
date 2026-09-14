/**
 * Benchmark tool source (NOVEMBER-PLAN.md wave 8, W56).
 *
 * Answers "how do we compare?" with exactly what /intel/benchmark shows,
 * because it calls the same adapter. If the page and the answer ever
 * disagreed, one of them would be wrong and the operator would have no
 * way to tell which, so there is only one path to the numbers.
 *
 * It refuses below the peer threshold. That refusal is the right answer,
 * not a failure: with one or two other venues a "middle figure" is an
 * average of almost nothing dressed up as a market rate. The refusal says
 * how many venues there are and how many are needed, so the operator
 * knows it is a waiting condition rather than a broken feature.
 *
 * Nothing it returns identifies a peer. The result carries a peer count,
 * a median, a middle-half range and the caller's own position, which is
 * the shape the service builds and this source only passes on.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { IntelToolSource, ToolSourceDeps } from './types'
import {
  buildBenchmarkView,
  type BenchmarkView,
} from '@/lib/intel/adapters/benchmark-view'
import { buildVenueBenchmark } from '@/lib/services/cohort/benchmark'

export const TOOL_GET_VENUE_BENCHMARK = 'get_venue_benchmark'

export interface BenchmarkToolResult {
  /** Peers in the comparison. Doubles as the tool's `n`. */
  n: number
  enoughData: boolean
  reason?: string
  /** True when the peers are sample venues rather than real ones. */
  demoPeers: boolean
  view: BenchmarkView | null
}

async function run(
  venueId: string,
  _args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<BenchmarkToolResult> {
  const result = await buildVenueBenchmark(deps.supabase, venueId)
  const view = buildBenchmarkView(result)

  if (!view.enoughPeers) {
    return {
      n: view.peerCount,
      enoughData: false,
      reason: view.gateMessage ?? 'Not enough other venues to compare against yet.',
      demoPeers: view.demoPeers,
      view: null,
    }
  }

  return {
    n: view.peerCount,
    enoughData: true,
    demoPeers: view.demoPeers,
    view,
  }
}

const tool: Anthropic.Tool = {
  name: TOOL_GET_VENUE_BENCHMARK,
  description:
    'How this venue compares with other venues on the platform, across six figures: enquiry-to-tour rate, tour-to-booking rate, median reply time, Monday-to-Friday tour conversion, review trend, and how much enquiry volume leans on the biggest channel. ' +
    'For each one it gives this venue’s own number, the middle figure across the other venues, the middle half of them, and the share of them this venue is ahead of. ' +
    'Use this for "how do we compare", "are we good at this", "is our reply time normal", "what is typical for a venue like us", or any question that needs an outside reference point rather than this venue’s own history. ' +
    'Other venues are anonymous: it reports how many there were and their middle, never which venues they are or what any single one scored. ' +
    'It refuses when there are fewer than three other venues to compare against, and the refusal says how many there are.',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
}

export const benchmarkToolSource: IntelToolSource = {
  tool,
  subjects: [
    'how this venue compares with other venues on enquiry-to-tour, tour-to-booking, reply time, weekday tour conversion, review trend and channel concentration',
    'whether a figure of ours is good or bad relative to other venues, rather than relative to our own past',
    'the middle figure and middle-half range across other venues, with no venue named',
  ],
  batteryQuestions: ['43'],
  run,
}
