/**
 * CRM-import API (T5-followup-Y / Pattern I closure).
 *
 * POST /api/onboarding/crm-import
 *   body: {
 *     adapter: 'honeybook' | 'dubsado' | 'aisle_planner' | 'generic_csv',
 *     csv?: string,
 *     json?: string,
 *     columnMapping?: Record<string, string>,
 *     preview?: boolean,
 *   }
 *
 *   preview=true → parse + return rows for coordinator review (no inserts)
 *   preview=false → parse + commit to weddings/interactions/tours/lost_deals
 *
 * Auth: getPlatformAuth — coordinator-only.
 *
 * The adapter does the parsing + the commit; the API route just routes
 * the request and gates auth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { findAdapter } from '@/lib/services/crm-import'

interface RequestBody {
  adapter?: string
  csv?: string
  json?: string
  columnMapping?: Record<string, string>
  preview?: boolean
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: RequestBody
  try {
    body = (await request.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const adapter = findAdapter(body.adapter ?? '')
  if (!adapter) {
    return NextResponse.json({ error: `unknown adapter: ${body.adapter}` }, { status: 400 })
  }

  const parsed = await adapter.parse({
    csvText: body.csv,
    jsonText: body.json,
    columnMapping: body.columnMapping,
  })

  if (!parsed.ok) {
    return NextResponse.json({
      ok: false,
      adapter: adapter.name,
      ready: adapter.ready,
      errors: parsed.errors,
      warnings: parsed.warnings,
      rows: [],
    }, { status: 400 })
  }

  if (body.preview) {
    const previewResult = adapter.preview(parsed.rows)
    return NextResponse.json({
      ok: true,
      preview: true,
      adapter: adapter.name,
      total: previewResult.total,
      rows: previewResult.rows,
      errors: previewResult.errors,
      warnings: [...parsed.warnings, ...previewResult.warnings],
    })
  }

  const supabase = createServiceClient()
  const commitResult = await adapter.commit({
    supabase,
    venueId: auth.venueId,
    rows: parsed.rows,
  })

  return NextResponse.json({
    ok: commitResult.ok,
    adapter: adapter.name,
    weddings_inserted: commitResult.weddingsInserted,
    interactions_inserted: commitResult.interactionsInserted,
    tours_inserted: commitResult.toursInserted,
    lost_deals_inserted: commitResult.lostDealsInserted,
    errors: commitResult.errors,
    warnings: parsed.warnings,
  }, { status: commitResult.ok ? 200 : 500 })
}

export async function GET() {
  // Returns the adapter manifest so the UI provider-picker can render
  // without hardcoding the list.
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { ADAPTERS } = await import('@/lib/services/crm-import')
  return NextResponse.json({
    adapters: ADAPTERS.map((a) => ({
      name: a.name,
      label: a.label,
      description: a.description,
      ready: a.ready,
    })),
  })
}
