/**
 * Susan-facing lifecycle pill derivation.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §3 ("Susan sees lifecycle as
 * status pills on the couple list").
 *
 * The DB stores `lifecycle_state` as a raw enum
 * (channel_scoped | resolved | booked | ghost | completed | agent).
 * Susan sees one of these friendly pills computed at render time. The
 * mapping is deterministic so the labels never disagree across
 * surfaces.
 *
 * Mapping (doctrine §3 + 2026-05-20 update):
 *   - Booked    = lifecycle_state === 'booked'    (signed contract, pre-wedding)
 *   - Completed = lifecycle_state === 'completed' (wedding date has passed)
 *   - Lost      = lifecycle_state === 'ghost'     (decayed lead)
 *   - Agent     = lifecycle_state === 'agent'
 *   - Active    = live person, progression in last 45 days
 *   - Cooling   = live person, 45-120 days quiet
 *   - Quiet     = live person, 120+ days quiet (near death, raw 'resolved')
 *
 * Naming note (2026-05-20):
 *   - "Past" was renamed to "Lost". Operators read "Past" as "wedding
 *     has already happened" but the underlying state 'ghost' means
 *     "lead decayed without booking." "Lost" matches the actual
 *     semantic and pairs cleanly with the new "Completed" pill for
 *     post-wedding couples.
 *   - The near-death pre-ghost state on a live resolved couple was
 *     also renamed from "Lost" -> "Quiet" so the two are distinct on
 *     the surface (Quiet = still resolveable, Lost = ghosted out).
 *
 * The decay sweep flips Quiet (raw 'resolved' 120-180d) to 'ghost'
 * after decay_window_days (default 180) per §3.
 */

export type StatusPill =
  | 'Active'
  | 'Cooling'
  | 'Quiet'
  | 'Lost'
  | 'Booked'
  | 'Completed'
  | 'Agent'
  | 'New'

export interface StatusPillInputs {
  lifecycle_state: string | null
  last_progression_at: string | null
  created_at?: string | null
}

export function deriveStatusPill(input: StatusPillInputs): StatusPill {
  if (input.lifecycle_state === 'booked') return 'Booked'
  if (input.lifecycle_state === 'completed') return 'Completed'
  if (input.lifecycle_state === 'ghost') return 'Lost'
  if (input.lifecycle_state === 'agent') return 'Agent'
  const ref = input.last_progression_at ?? input.created_at
  if (!ref) return 'New'
  const days = Math.floor((Date.now() - Date.parse(ref)) / 86_400_000)
  if (days <= 45) return 'Active'
  if (days <= 120) return 'Cooling'
  return 'Quiet'
}

export function statusPillColor(pill: StatusPill): string {
  switch (pill) {
    case 'Active':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'Cooling':
      return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'Quiet':
      return 'bg-orange-100 text-orange-800 border-orange-200'
    case 'Lost':
      return 'bg-stone-100 text-stone-500 border-stone-200'
    case 'Booked':
      return 'bg-sky-100 text-sky-800 border-sky-200'
    case 'Completed':
      return 'bg-indigo-100 text-indigo-800 border-indigo-200'
    case 'Agent':
      return 'bg-violet-100 text-violet-800 border-violet-200'
    case 'New':
      return 'bg-stone-100 text-stone-700 border-stone-200'
  }
}
