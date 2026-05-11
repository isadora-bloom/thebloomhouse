/**
 * Wave 25 — public share endpoint.
 *
 * GET /api/public/channels/exports/[shareToken]
 *
 * Anonymous lookup. Returns the frozen snapshot as HTML/CSV/JSON.
 * The share_token is the secret — anyone with the link sees the
 * snapshot. snapshot_jsonb is already a non-PII view (no wedding ids,
 * no couple names) by construction in generateExport.
 *
 * RLS allows anon SELECT on channel_presentation_exports where
 * share_token IS NOT NULL. This endpoint enforces the share_token
 * filter — RLS is belt to the endpoint's suspenders.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { renderFrozenExport } from '@/lib/services/channel-intel-hub/export'

export const maxDuration = 30

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ shareToken: string }> },
) {
  const { shareToken } = await params
  if (!shareToken || shareToken.length < 8) {
    return NextResponse.json({ ok: false, error: 'invalid share_token' }, { status: 400 })
  }

  try {
    const sb = createServiceClient()
    const { data, error } = await sb
      .from('channel_presentation_exports')
      .select('id, channel_slug, format, snapshot_jsonb, expires_at, exported_at, venue_id')
      .eq('share_token', shareToken)
      .maybeSingle()
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    }
    if (data.expires_at && Date.parse(data.expires_at) < Date.now()) {
      return NextResponse.json({ ok: false, error: 'link expired' }, { status: 410 })
    }

    const format = data.format as 'pdf' | 'pptx' | 'csv' | 'json'
    if (format === 'json') {
      return NextResponse.json({ ok: true, snapshot: data.snapshot_jsonb })
    }
    if (format === 'csv') {
      // The snapshot_jsonb has the same shape we serialized; we don't
      // re-derive CSV here (would require re-rendering). Return JSON for
      // CSV requests at the public endpoint and let the operator handle
      // the offline download. The original CSV is delivered at export
      // time via the body in /export's response.
      return NextResponse.json({ ok: true, snapshot: data.snapshot_jsonb })
    }
    // pdf / pptx → HTML render (browser print-to-PDF).
    const html = renderFrozenExport(data.snapshot_jsonb as Record<string, unknown>)
    return new NextResponse(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
