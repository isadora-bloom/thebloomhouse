/**
 * The one save route for a seating assignment.
 *
 * Before this, the floor plan and the assignment list were separate features
 * that happened to touch the same table, so they could drift. Both now call
 * `saveTableAssignment`, which writes the authoritative column and nothing
 * else. See `seating-view.ts` for why `guest_list.table_assignment` is the
 * authoritative column.
 *
 * Deliberately narrow: no venue or wedding scoping is applied here because
 * the caller already holds a guest id it read under the couple's own RLS
 * scope, and widening this into a general guest writer is how the seating
 * page ends up owning the guest list.
 */

import { writeOrLog } from '@/lib/db/write-or-log'

/** Only the fragment of the Supabase client this module uses. */
export interface SeatingWriteClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<{ error: { message: string; code?: string } | null }>
    }
  }
}

export interface SaveAssignmentArgs {
  guestId: string
  /** The table's name, or null to take the party off every table. */
  tableName: string | null
  venueId?: string | null
}

export interface SaveAssignmentResult {
  error: { message: string; code?: string } | null
}

export async function saveTableAssignment(
  supabase: SeatingWriteClient,
  { guestId, tableName, venueId = null }: SaveAssignmentArgs,
): Promise<SaveAssignmentResult> {
  const trimmed = tableName === null ? null : tableName.trim()
  const value = trimmed ? trimmed : null
  return writeOrLog(
    supabase.from('guest_list').update({ table_assignment: value }).eq('id', guestId),
    {
      op: value === null ? 'guest_list.unseat' : 'guest_list.seat',
      venueId,
      actor: 'seating_board',
    },
  )
}

/** Take a party off whichever table it was on. One click, one write. */
export function clearTableAssignment(
  supabase: SeatingWriteClient,
  guestId: string,
  venueId?: string | null,
): Promise<SaveAssignmentResult> {
  return saveTableAssignment(supabase, { guestId, tableName: null, venueId })
}
