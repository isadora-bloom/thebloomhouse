/**
 * Susan-facing lifecycle pill derivation.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §3 ("Susan sees lifecycle as
 * status pills on the couple list").
 *
 * The DB stores `lifecycle_state` as a raw enum
 * (channel_scoped | resolved | booked | ghost | agent). Susan sees
 * one of five friendly pills computed at render time from the raw
 * state plus days-since-last-progression. The mapping is
 * deterministic so the labels never disagree across surfaces.
 *
 * Mapping (doctrine §3 Susan):
 *   - Booked    = lifecycle_state === 'booked'
 *   - Past      = lifecycle_state === 'ghost'
 *   - Agent     = lifecycle_state === 'agent'
 *   - Active    = live person, progression in last 45 days
 *   - Cooling   = live person, 45-120 days quiet
 *   - Lost      = live person, 120+ days quiet (near death)
 *
 * The decay sweep flips Lost (raw 'resolved') to 'ghost' after
 * `decay_window_days` (default 180) per §3 build SQL. So Lost is the
 * short-window state between 120d quiet and the eventual Ghost flip.
 */

export type StatusPill =
  | 'Active'
  | 'Cooling'
  | 'Lost'
  | 'Past'
  | 'Booked'
  | 'Agent'
  | 'New'

export interface StatusPillInputs {
  lifecycle_state: string | null
  last_progression_at: string | null
  created_at?: string | null
}

export function deriveStatusPill(input: StatusPillInputs): StatusPill {
  if (input.lifecycle_state === 'booked') return 'Booked'
  if (input.lifecycle_state === 'ghost') return 'Past'
  if (input.lifecycle_state === 'agent') return 'Agent'
  const ref = input.last_progression_at ?? input.created_at
  if (!ref) return 'New'
  const days = Math.floor((Date.now() - Date.parse(ref)) / 86_400_000)
  if (days <= 45) return 'Active'
  if (days <= 120) return 'Cooling'
  return 'Lost'
}

export function statusPillColor(pill: StatusPill): string {
  switch (pill) {
    case 'Active':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'Cooling':
      return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'Lost':
      return 'bg-orange-100 text-orange-800 border-orange-200'
    case 'Past':
      return 'bg-stone-100 text-stone-500 border-stone-200'
    case 'Booked':
      return 'bg-sky-100 text-sky-800 border-sky-200'
    case 'Agent':
      return 'bg-violet-100 text-violet-800 border-violet-200'
    case 'New':
      return 'bg-stone-100 text-stone-700 border-stone-200'
  }
}
