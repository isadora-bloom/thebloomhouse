/**
 * Staff seed helper for §12 Staffing tests.
 *
 * The Bloom House schema does NOT have a dedicated `staff_members` table.
 * Staff presence on a wedding is modelled as rows in `staffing_assignments`
 * keyed by (venue_id, wedding_id, role, person_name). This helper inserts
 * those rows and tracks them on a TestContext so the caller can clean up
 * via `cleanupStaffingAssignments(ctx)` in afterEach.
 *
 * Do NOT modify `e2e/helpers/seed.ts`. This file extends it non-invasively
 * using the `ctx.extra` bag.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { TestContext } from './seed'

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('staff-seed: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from env')
  }
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

const BAG_KEY = 'staffingAssignmentIds'

export type StaffRole =
  | 'bartender'
  | 'server'
  | 'runner'
  | 'line_cook'
  | 'coordinator'
  | 'other'

export interface StaffAssignmentOpts {
  venueId: string
  weddingId: string
  role?: StaffRole
  personName?: string
  count?: number
  hourlyRate?: number
  hours?: number
  notes?: string
}

export interface StaffAssignmentRow {
  id: string
  venue_id: string
  wedding_id: string
  role: string | null
  person_name: string | null
  hours: number | null
  hourly_rate: number | null
  notes: string | null
}

/**
 * Insert one staffing_assignments row and track its id for cleanup.
 */
export async function insertStaffAssignment(
  ctx: TestContext,
  opts: StaffAssignmentOpts
): Promise<StaffAssignmentRow> {
  const payload = {
    venue_id: opts.venueId,
    wedding_id: opts.weddingId,
    role: opts.role ?? 'bartender',
    person_name: opts.personName ?? `E2E Staff ${ctx.testId}`,
    count: opts.count ?? 1,
    hourly_rate: opts.hourlyRate ?? 35,
    hours: opts.hours ?? 8,
    notes: opts.notes ?? `[e2e:${ctx.testId}]`,
  }
  const { data, error } = await admin()
    .from('staffing_assignments')
    .insert(payload)
    .select('id, venue_id, wedding_id, role, person_name, hours, hourly_rate, notes')
    .single()
  if (error) throw new Error(`insertStaffAssignment: ${error.message}`)

  const bag = (ctx.extra[BAG_KEY] ??= [])
  bag.push(data.id)
  return data as StaffAssignmentRow
}

/**
 * List staffing_assignments for a wedding. Filters out the couple-side
 * calculator stash row (role='_calculator') used by the couple staffing page.
 */
export async function listStaffForWedding(
  weddingId: string
): Promise<StaffAssignmentRow[]> {
  const { data, error } = await admin()
    .from('staffing_assignments')
    .select('id, venue_id, wedding_id, role, person_name, hours, hourly_rate, notes')
    .eq('wedding_id', weddingId)
  if (error) throw new Error(`listStaffForWedding: ${error.message}`)
  return (data ?? []).filter((r) => r.role !== '_calculator') as StaffAssignmentRow[]
}

/**
 * Delete every staffing_assignments row this context created.
 * Call from afterEach AFTER cleanup() if you want strict order, or just
 * rely on FK ON DELETE CASCADE when the wedding/venue goes away.
 */
export async function cleanupStaffingAssignments(ctx: TestContext): Promise<void> {
  const ids = ctx.extra[BAG_KEY] ?? []
  if (!ids.length) return
  try {
    await admin().from('staffing_assignments').delete().in('id', ids)
  } catch (e) {
    console.warn('cleanupStaffingAssignments warning:', e)
  }
  ctx.extra[BAG_KEY] = []
}
