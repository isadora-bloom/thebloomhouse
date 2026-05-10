/**
 * Wave 6A — spend summary aggregation endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * GET query:
 *   {
 *     venueId?,
 *     fromDate?,
 *     toDate?,
 *     groupBy?: 'channel' | 'campaign' | 'persona'  // default 'channel'
 *   }
 *
 * groupBy='channel'  → SUM(amount_cents) GROUP BY channel
 * groupBy='campaign' → SUM(amount_cents) GROUP BY (channel, campaign_name)
 * groupBy='persona'  → spend acquired per persona, joined via
 *                       attribution_events.persona_overlay
 *
 * Returns:
 *   {
 *     ok: true,
 *     venueId,
 *     totalCents,
 *     groupBy,
 *     groups: [{ key, label?, totalCents, rowCount }]
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

export const maxDuration = 30

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
      return badRequest('CRON_SECRET path requires venueId query param')
    }
    return { ctx: { isCron: true, venueId: bodyVenueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot summarise spend')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

interface SpendRow {
  channel: string
  campaign_name: string | null
  amount_cents: number
  spend_date: string
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const fromDate = url.searchParams.get('fromDate')
  const toDate = url.searchParams.get('toDate')
  const groupByRaw = url.searchParams.get('groupBy') ?? 'channel'
  const groupBy =
    groupByRaw === 'campaign' || groupByRaw === 'persona'
      ? groupByRaw
      : 'channel'

  const authResolved = await resolveAuth(req, venueIdParam)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const supabase = createServiceClient()

  // Pull all matching spend rows. Server-side aggregation rather than
  // a SQL GROUP BY because PostgREST doesn't easily expose it; the
  // row count is bounded (per-venue per-window) so this is cheap.
  let q = supabase
    .from('marketing_spend_records')
    .select('channel, campaign_name, amount_cents, spend_date')
    .eq('venue_id', venueId)
  if (fromDate) q = q.gte('spend_date', fromDate)
  if (toDate) q = q.lte('spend_date', toDate)

  const { data, error } = await q
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }

  const rows = (data ?? []) as SpendRow[]
  const totalCents = rows.reduce((acc, r) => acc + (r.amount_cents || 0), 0)

  if (groupBy === 'channel' || groupBy === 'campaign') {
    const acc = new Map<
      string,
      { key: string; label: string; totalCents: number; rowCount: number }
    >()
    for (const r of rows) {
      const key =
        groupBy === 'channel'
          ? r.channel
          : `${r.channel}::${r.campaign_name ?? 'unspecified'}`
      const label =
        groupBy === 'channel'
          ? r.channel
          : `${r.channel} / ${r.campaign_name ?? 'unspecified'}`
      const existing = acc.get(key)
      if (existing) {
        existing.totalCents += r.amount_cents
        existing.rowCount += 1
      } else {
        acc.set(key, { key, label, totalCents: r.amount_cents, rowCount: 1 })
      }
    }
    const groups = Array.from(acc.values()).sort(
      (a, b) => b.totalCents - a.totalCents,
    )
    return NextResponse.json({
      ok: true,
      venueId,
      groupBy,
      totalCents,
      groups,
    })
  }

  // groupBy='persona' — Wave 6A's headline join. Pull attribution_events
  // for the venue with persona_overlay set, then aggregate spend per
  // persona by matching first-touch attributions to the venue's spend
  // window. NB: this is a coarse approximation for Wave 6A surfacing
  // (smoke test). Wave 6B replaces this with the full rollup table
  // that joins spend_date windows to wedding inquiry dates.
  const { data: attrRows, error: attrErr } = await supabase
    .from('attribution_events')
    .select('source_platform, persona_overlay, decided_at')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
    .not('persona_overlay', 'is', null)

  if (attrErr) {
    return NextResponse.json(
      { ok: false, error: attrErr.message },
      { status: 500 },
    )
  }

  // Persona × source_platform credit map: counts how many attributions
  // each persona has per platform. We use that as a weight to split
  // each platform's spend across personas.
  const personaWeights = new Map<string, Map<string, number>>() // platform -> persona -> count
  const personaSet = new Set<string>()
  const attrCast =
    (attrRows ?? []) as Array<{
      source_platform: string
      persona_overlay: { persona_label?: string } | null
    }>
  for (const a of attrCast) {
    const persona = a.persona_overlay?.persona_label
    if (!persona) continue
    personaSet.add(persona)
    let inner = personaWeights.get(a.source_platform)
    if (!inner) {
      inner = new Map()
      personaWeights.set(a.source_platform, inner)
    }
    inner.set(persona, (inner.get(persona) ?? 0) + 1)
  }

  // Aggregate spend per channel (proxy for source_platform — channel
  // strings overlap heuristically with source_platform strings).
  const spendByChannel = new Map<string, number>()
  for (const r of rows) {
    spendByChannel.set(
      r.channel,
      (spendByChannel.get(r.channel) ?? 0) + r.amount_cents,
    )
  }

  // For each channel with attributed personas, distribute spend by
  // attribution share. Channels without persona attributions roll up
  // under 'unattributed'.
  const personaTotals = new Map<string, number>()
  let unattributed = 0
  let attributedChannelRowCount = 0

  for (const [channel, channelTotal] of spendByChannel.entries()) {
    const inner = personaWeights.get(channel)
    if (!inner || inner.size === 0) {
      unattributed += channelTotal
      continue
    }
    const sumWeights = Array.from(inner.values()).reduce((a, b) => a + b, 0)
    if (sumWeights === 0) {
      unattributed += channelTotal
      continue
    }
    attributedChannelRowCount += 1
    for (const [persona, weight] of inner.entries()) {
      const share = (channelTotal * weight) / sumWeights
      personaTotals.set(persona, (personaTotals.get(persona) ?? 0) + share)
    }
  }

  const groups = Array.from(personaTotals.entries())
    .map(([persona, cents]) => ({
      key: persona,
      label: persona,
      totalCents: Math.round(cents),
      rowCount: 0,
    }))
    .sort((a, b) => b.totalCents - a.totalCents)

  if (unattributed > 0) {
    groups.push({
      key: 'unattributed',
      label: 'unattributed',
      totalCents: Math.round(unattributed),
      rowCount: 0,
    })
  }

  return NextResponse.json({
    ok: true,
    venueId,
    groupBy: 'persona',
    totalCents,
    groups,
    diagnostics: {
      personaCount: personaSet.size,
      attributedChannelCount: attributedChannelRowCount,
      attributionEventsScanned: attrCast.length,
    },
  })
}
