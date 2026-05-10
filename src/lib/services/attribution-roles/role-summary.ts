/**
 * Wave 7B — channel-role summary aggregator.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B)
 *
 * Reads attribution_events for one venue and groups counts by role
 * AND by source_platform. Returns the aggregate that powers the
 * /api/admin/attribution/role-summary endpoint and the discovery
 * surface.
 *
 * The reveal: "30% of Knot leads are validation, not acquisition."
 * The output shape lets the caller compute that ratio directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import type { ClassifyResult } from './classify'

export type Role = ClassifyResult['role']

const ALL_ROLES: readonly Role[] = ['acquisition', 'validation', 'conversion', 'mixed', 'unknown']

export interface PerChannelRoleCounts {
  channel: string
  total: number
  acquisition: number
  validation: number
  conversion: number
  mixed: number
  unknown: number
  /** acquisition / (acquisition + validation). null when both 0. */
  acquisition_share_0_1: number | null
  /** validation / (acquisition + validation). null when both 0. */
  validation_share_0_1: number | null
}

export interface RoleSummary {
  venueId: string
  totalEvents: number
  byRole: Record<Role, number>
  byChannel: PerChannelRoleCounts[]
  unclassifiedCount: number
  /** ISO of newest role_classified_at (null when no rows classified). */
  latestClassifiedAt: string | null
}

interface AttributionEventCountRow {
  role: Role | null
  source_platform: string | null
  role_classified_at: string | null
}

/**
 * Build the role-summary aggregate for one venue. Reads the venue's
 * attribution_events.role + source_platform columns and bucket-counts
 * them into per-role totals and per-channel distributions.
 */
export async function getRoleSummary(
  venueId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<RoleSummary> {
  const sb = options.supabase ?? createServiceClient()

  // Load every attribution_event for the venue. attribution_events tops
  // out at low thousands per venue (Rixey is 433); a single fetch is
  // cheap and avoids count-per-bucket round-trips.
  const PAGE_SIZE = 1000
  const rows: AttributionEventCountRow[] = []
  let from = 0
  // Bound the loop at 50k rows per venue — anything bigger means we
  // need server-side aggregation, but we have not seen a venue larger
  // than 5k yet.
  while (rows.length < 50_000) {
    const { data, error } = await sb
      .from('attribution_events')
      .select('role, source_platform, role_classified_at')
      .eq('venue_id', venueId)
      .is('reverted_at', null)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`getRoleSummary: ${error.message}`)
    const page = (data ?? []) as AttributionEventCountRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const byRole: Record<Role, number> = {
    acquisition: 0,
    validation: 0,
    conversion: 0,
    mixed: 0,
    unknown: 0,
  }
  const channelMap = new Map<string, PerChannelRoleCounts>()
  let unclassifiedCount = 0
  let latestClassifiedAt: string | null = null

  for (const r of rows) {
    const role: Role =
      r.role && (ALL_ROLES as readonly string[]).includes(r.role) ? (r.role as Role) : 'unknown'
    byRole[role] = (byRole[role] ?? 0) + 1
    if (role === 'unknown') unclassifiedCount += 1

    const channel = r.source_platform ?? '(unknown)'
    let cell = channelMap.get(channel)
    if (!cell) {
      cell = {
        channel,
        total: 0,
        acquisition: 0,
        validation: 0,
        conversion: 0,
        mixed: 0,
        unknown: 0,
        acquisition_share_0_1: null,
        validation_share_0_1: null,
      }
      channelMap.set(channel, cell)
    }
    cell.total += 1
    cell[role] += 1

    if (r.role_classified_at) {
      if (!latestClassifiedAt || r.role_classified_at > latestClassifiedAt) {
        latestClassifiedAt = r.role_classified_at
      }
    }
  }

  // Compute the acquisition vs validation share per channel — the
  // headline ratio "X% of Knot is validation".
  for (const cell of channelMap.values()) {
    const denom = cell.acquisition + cell.validation
    if (denom > 0) {
      cell.acquisition_share_0_1 = cell.acquisition / denom
      cell.validation_share_0_1 = cell.validation / denom
    }
  }

  // Sort by total desc.
  const byChannel = [...channelMap.values()].sort((a, b) => b.total - a.total)

  return {
    venueId,
    totalEvents: rows.length,
    byRole,
    byChannel,
    unclassifiedCount,
    latestClassifiedAt,
  }
}
