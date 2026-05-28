/**
 * Bloom House — Cohort-action API.
 *
 * POST /api/agent/cohort
 *
 * One endpoint, three actions discriminated by body.action:
 *
 *   { action: 'parse',  input: string, today?: string }   → CohortQuery
 *   { action: 'preview', query: CohortQuery, limit?: number } → CohortExecutionResult
 *   { action: 'draft',  weddingIds: string[] }            → BulkFollowUpResult
 *
 * One-endpoint-three-actions because the UI flow is a single conversation
 * (NL input → list → confirm-and-draft). Splitting into three routes
 * would force three auth/scope checks and three demo-block decisions
 * with no real benefit.
 *
 * Auth: getPlatformAuth() (coordinator / manager / admin). Demo blocked
 * on `draft` only — parse + preview are read-only and safe to expose to
 * demo accounts so the workflow can be demoed against seed data.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  parseCohortQuery,
  type CohortQuery,
} from '@/lib/services/brain/cohort-query'
import { executeCohortQuery } from '@/lib/services/cohort/operator-query'
import { bulkDraftFollowUps } from '@/lib/services/cohort/bulk-follow-up'

export const maxDuration = 300

interface CohortRequestBody {
  action?: 'parse' | 'preview' | 'draft'
  input?: string
  today?: string
  query?: CohortQuery
  limit?: number
  weddingIds?: string[]
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.venueId) {
    return NextResponse.json(
      { error: 'No venue scope on session' },
      { status: 403 },
    )
  }
  const venueId = auth.venueId

  let body: CohortRequestBody
  try {
    body = (await request.json()) as CohortRequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const correlationId = `cohort-${randomUUID()}`

  // -----------------------------------------------------------------------
  // parse — NL → CohortQuery
  // -----------------------------------------------------------------------
  if (body.action === 'parse') {
    if (!body.input || typeof body.input !== 'string') {
      return NextResponse.json({ error: 'Missing input string' }, { status: 400 })
    }
    const today = body.today ?? new Date().toISOString().slice(0, 10)
    try {
      const query = await parseCohortQuery({
        input: body.input,
        today,
        venueId,
        correlationId,
      })
      return NextResponse.json({ ok: true, query, correlationId })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Parse failed'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // -----------------------------------------------------------------------
  // preview — CohortQuery → CoupleListItem[]
  // -----------------------------------------------------------------------
  if (body.action === 'preview') {
    if (!body.query || typeof body.query !== 'object') {
      return NextResponse.json(
        { error: 'Missing query in body' },
        { status: 400 },
      )
    }
    try {
      const result = await executeCohortQuery({
        query: body.query,
        venueId,
        limit: body.limit,
      })
      return NextResponse.json({ ok: true, ...result, correlationId })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Preview failed'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // -----------------------------------------------------------------------
  // draft — confirmed weddingIds → bulk follow-up drafts
  // -----------------------------------------------------------------------
  if (body.action === 'draft') {
    if (auth.isDemo) {
      return NextResponse.json(
        {
          error:
            'Bulk-draft is disabled in demo mode (no real Anthropic calls or draft writes against the demo seed).',
        },
        { status: 403 },
      )
    }
    if (!Array.isArray(body.weddingIds) || body.weddingIds.length === 0) {
      return NextResponse.json(
        { error: 'Missing weddingIds array' },
        { status: 400 },
      )
    }
    // Bounded — the verification UI caps at 50 by default; if a caller
    // sends 500 we refuse rather than spend $5 of tokens on a typo.
    if (body.weddingIds.length > 100) {
      return NextResponse.json(
        { error: 'weddingIds too large (max 100 per call)' },
        { status: 400 },
      )
    }
    try {
      const result = await bulkDraftFollowUps({
        venueId,
        weddingIds: body.weddingIds,
        correlationId,
      })
      return NextResponse.json({ ok: true, ...result, correlationId })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bulk-draft failed'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  return NextResponse.json(
    { error: `Unknown action: ${body.action}. Use 'parse' / 'preview' / 'draft'.` },
    { status: 400 },
  )
}
