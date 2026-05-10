/**
 * Wave 7C — read most-recent validation run + the discovery's current
 * validation status.
 *
 * GET /api/admin/intel/discoveries/{id}/validation-result
 *
 * Auth: getPlatformAuth (coordinator UI). The discovery must belong to
 * the caller's venue (403 otherwise).
 *
 * Returns:
 *   {
 *     ok: true,
 *     discovery: {
 *       id, venue_id, validation_status, validation_started_at,
 *       validation_completed_at, validation_runs_count,
 *       validation_test_plan, validation_result_summary,
 *       validation_metric, validated_at
 *     },
 *     mostRecentRun: { ... } | null
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { getMostRecentValidationRun } from '@/lib/services/intel/validation/run-validation'

export const maxDuration = 30

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: discoveryId } = await context.params
  if (!discoveryId || typeof discoveryId !== 'string') {
    return badRequest('discovery id required in path')
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()

  const { data: discoveryRow } = await supabase
    .from('intel_discoveries')
    .select(
      'id, venue_id, validation_status, validation_started_at, validation_completed_at, validation_runs_count, validation_test_plan, validation_result_summary, validation_metric, validated_at',
    )
    .eq('id', discoveryId)
    .maybeSingle()
  if (!discoveryRow) return notFound('discovery')

  const row = discoveryRow as {
    id: string
    venue_id: string
    validation_status: string
    validation_started_at: string | null
    validation_completed_at: string | null
    validation_runs_count: number | null
    validation_test_plan: Record<string, unknown> | null
    validation_result_summary: string | null
    validation_metric: Record<string, unknown> | null
    validated_at: string | null
  }

  if (auth.role !== 'super_admin' && row.venue_id !== auth.venueId) {
    return forbidden('discovery belongs to a different venue')
  }

  try {
    const mostRecentRun = await getMostRecentValidationRun(discoveryId, supabase)
    return NextResponse.json({
      ok: true,
      discovery: {
        id: row.id,
        venue_id: row.venue_id,
        validation_status: row.validation_status,
        validation_started_at: row.validation_started_at,
        validation_completed_at: row.validation_completed_at,
        validation_runs_count: row.validation_runs_count ?? 0,
        validation_test_plan: row.validation_test_plan,
        validation_result_summary: row.validation_result_summary,
        validation_metric: row.validation_metric,
        validated_at: row.validated_at,
      },
      mostRecentRun,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
