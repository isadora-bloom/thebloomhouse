/**
 * The couples behind a channel's number.
 *
 * `getSourceAttribution` answers "how is this channel doing" as a rate.
 * Sooner or later an operator clicks the rate and asks "which couples
 * is that?" — the agency drill-down, mostly. Answering that from a
 * different query is how a channel comes to show 17 leads on one screen
 * and list 14 on the next.
 *
 * So this reader runs the SAME builder the canonical reader runs
 * (`buildCoupleAttribution`, which reads `couples` + `touchpoints`
 * through `loadCohortData`), takes its per-couple credit rows, and keeps
 * the ones credited to the channels asked for. The rate and the list
 * therefore come out of one derivation by construction: if the list is
 * wrong, the rate is wrong in the same way, and both are fixed in one
 * place.
 *
 * What the spine cannot say
 * -------------------------
 * There is no revenue column on `couples`, so a lead's value is null
 * here, always. The old drill-down printed `weddings.quoted_value`, and
 * a quoted value is not a booked value; a surface should print a dash
 * and say why rather than a number nobody committed to.
 *
 * Injectable client, no service-role import. Unit-tested in
 * ./__tests__/channel-leads.test.ts against the in-memory fake.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AttributionModel } from '@/lib/intel/canonical'

export interface ChannelLead {
  coupleId: string
  /** The wedding this couple was minted from, when there is one. Links
   *  into the wedding-keyed operator surfaces still need it. */
  sourceWeddingId: string | null
  names: string | null
  primaryContactName: string | null
  partnerContactName: string | null
  /** Spine lifecycle. The one vocabulary the pills speak. */
  lifecycleState: string | null
  outcome: 'booked' | 'ghost' | 'in_progress'
  bookedAt: string | null
  weddingDate: string | null
  /** Earliest acquisition touch on a credited channel. */
  firstTouchAt: string | null
  attributedChannel: string | null
  /** Credit weight under the chosen model. 1 under first and last touch,
   *  a fraction under linear and time decay. Printed so a fractional
   *  lead does not read as a whole one. */
  creditWeight: number
  /** Always null: `couples` carries no revenue column. Kept in the shape
   *  so a surface renders "—" deliberately rather than by accident. */
  valueCents: null
}

export interface ChannelLeadsOpts {
  /** Channel keys to keep. Empty means "no channels", which returns []. */
  channels: readonly string[]
  model?: AttributionModel
  /** Inclusive lower bound on touchpoint occurred_at (ISO). */
  since?: string | null
}

interface CoupleDisplayRow {
  id: string
  source_wedding_id: string | null
  primary_contact_name: string | null
  partner_contact_name: string | null
  wedding_date: string | null
}

function coupleNames(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

/**
 * Couples credited to any of `channels`, newest first-touch first.
 *
 * `buildCoupleAttribution` is imported dynamically for the same reason
 * the canonical readers do it: it drags in the cohort loader, and a
 * caller that only wants the types should not pay for that at module
 * load.
 */
export async function loadChannelLeads(
  supabase: SupabaseClient,
  venueId: string,
  opts: ChannelLeadsOpts,
): Promise<ChannelLead[]> {
  if (!venueId || opts.channels.length === 0) return []
  const model: AttributionModel = opts.model ?? 'first_touch'
  const wanted = new Set(opts.channels)

  const { buildCoupleAttribution } = await import(
    '@/lib/services/attribution/couple-attribution'
  )
  const result = await buildCoupleAttribution(supabase, venueId, {
    since: opts.since ?? null,
  })

  // Keep the couples with credit on a wanted channel, and remember which
  // channel earned it plus how much of them it earned.
  const credited: Array<{
    coupleId: string
    lifecycleState: string
    outcome: ChannelLead['outcome']
    bookedAt: string | null
    channel: string
    weight: number
    firstTouchAt: string | null
  }> = []

  for (const c of result.couples) {
    let best: { channel: string; weight: number } | null = null
    for (const credit of c.credits[model]) {
      if (!wanted.has(credit.channel)) continue
      if (!best || credit.weight > best.weight) best = credit
    }
    if (!best) continue
    const firstOnChannel = c.ribbon.find(
      (t) => t.isAcquisition && t.channel === best.channel,
    )
    credited.push({
      coupleId: c.coupleId,
      lifecycleState: c.lifecycleState,
      outcome: c.outcome,
      bookedAt: c.bookedAt,
      channel: best.channel,
      weight: best.weight,
      firstTouchAt: firstOnChannel?.occurredAt ?? null,
    })
  }

  if (credited.length === 0) return []

  // Display columns, straight off the spine, for exactly those couples.
  const { data } = await supabase
    .from('couples')
    .select('id, source_wedding_id, primary_contact_name, partner_contact_name, wedding_date')
    .eq('venue_id', venueId)
    .in('id', credited.map((c) => c.coupleId))
  const displayById = new Map<string, CoupleDisplayRow>(
    ((data ?? []) as CoupleDisplayRow[]).map((r) => [r.id, r]),
  )

  const leads: ChannelLead[] = credited.map((c) => {
    const d = displayById.get(c.coupleId)
    return {
      coupleId: c.coupleId,
      sourceWeddingId: d?.source_wedding_id ?? null,
      names: coupleNames(d?.primary_contact_name ?? null, d?.partner_contact_name ?? null),
      primaryContactName: d?.primary_contact_name ?? null,
      partnerContactName: d?.partner_contact_name ?? null,
      lifecycleState: c.lifecycleState,
      outcome: c.outcome,
      bookedAt: c.bookedAt,
      weddingDate: d?.wedding_date ?? null,
      firstTouchAt: c.firstTouchAt,
      attributedChannel: c.channel,
      creditWeight: c.weight,
      valueCents: null,
    }
  })

  leads.sort((a, b) => (b.firstTouchAt ?? '').localeCompare(a.firstTouchAt ?? ''))
  return leads
}
