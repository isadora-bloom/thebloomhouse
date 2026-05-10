/**
 * Wave 6D — A/B tests collection endpoint.
 *
 * GET  /api/admin/intel/marketing-loop/ab-tests?venueId=&status=
 *   List tests for a venue.
 *
 * POST /api/admin/intel/marketing-loop/ab-tests
 *   Body: { venueId?, testConfig: { test_name, hypothesis,
 *     variant_a_label, variant_b_label, channel, target_persona?,
 *     auto_start?, notes?, initial_variant_a_attribution_event_ids?,
 *     initial_variant_b_attribution_event_ids? } }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  createAbTest,
  listAbTests,
} from '@/lib/services/marketing-spend/loop'

export const maxDuration = 30

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'planning',
  'running',
  'concluded',
  'abandoned',
])

interface AuthContext {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  bodyVenueId: string | null,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!bodyVenueId) {
      return badRequest('CRON_SECRET path requires venueId')
    }
    return { ctx: { isCron: true, venueId: bodyVenueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot manage A/B tests')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const statusParam = url.searchParams.get('status')

  const authResolved = await resolveAuth(req, venueIdParam)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const status =
    statusParam && VALID_STATUSES.has(statusParam) ? statusParam : undefined

  try {
    const tests = await listAbTests(venueId, { status })
    return NextResponse.json({ ok: true, venueId, tests })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

interface PostBody {
  venueId?: string
  testConfig?: {
    test_name?: string
    hypothesis?: string
    variant_a_label?: string
    variant_b_label?: string
    channel?: string
    target_persona?: string | null
    auto_start?: boolean
    notes?: string | null
    initial_variant_a_attribution_event_ids?: string[]
    initial_variant_b_attribution_event_ids?: string[]
  }
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    return badRequest('invalid JSON body')
  }

  const authResolved = await resolveAuth(req, body.venueId ?? null)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const cfg = body.testConfig
  if (!cfg) return badRequest('testConfig is required')
  if (!cfg.test_name || typeof cfg.test_name !== 'string') {
    return badRequest('testConfig.test_name is required')
  }
  if (!cfg.hypothesis || typeof cfg.hypothesis !== 'string') {
    return badRequest('testConfig.hypothesis is required')
  }
  if (!cfg.variant_a_label || typeof cfg.variant_a_label !== 'string') {
    return badRequest('testConfig.variant_a_label is required')
  }
  if (!cfg.variant_b_label || typeof cfg.variant_b_label !== 'string') {
    return badRequest('testConfig.variant_b_label is required')
  }
  if (!cfg.channel || typeof cfg.channel !== 'string') {
    return badRequest('testConfig.channel is required')
  }

  const aIds = Array.isArray(cfg.initial_variant_a_attribution_event_ids)
    ? cfg.initial_variant_a_attribution_event_ids.filter(
        (x): x is string => typeof x === 'string',
      )
    : []
  const bIds = Array.isArray(cfg.initial_variant_b_attribution_event_ids)
    ? cfg.initial_variant_b_attribution_event_ids.filter(
        (x): x is string => typeof x === 'string',
      )
    : []

  try {
    const r = await createAbTest({
      venueId,
      testConfig: {
        test_name: cfg.test_name,
        hypothesis: cfg.hypothesis,
        variant_a_label: cfg.variant_a_label,
        variant_b_label: cfg.variant_b_label,
        channel: cfg.channel,
        target_persona:
          typeof cfg.target_persona === 'string' ? cfg.target_persona : null,
        auto_start: cfg.auto_start !== false,
        notes: typeof cfg.notes === 'string' ? cfg.notes : null,
        initial_variant_a_attribution_event_ids: aIds,
        initial_variant_b_attribution_event_ids: bIds,
      },
    })
    return NextResponse.json({
      ok: true,
      testId: r.testId,
      status: r.status,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
