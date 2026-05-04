import { redirect } from 'next/navigation'

/**
 * /intel/capacity was retired 2026-05-03 (Stream ZZZ).
 *
 * The page had no live writer — it read exclusively from
 * `venue_config.feature_flags.capacity_2026`, populated only by
 * `supabase/seed-capacity.sql` (also deleted). Real venues saw empty
 * cards; demo venues silently rendered seeded numbers as if live.
 *
 * Bookmarks redirect to `/intel/portfolio` so old links don't 404.
 */
export default function CapacityRetiredRedirect(): never {
  redirect('/intel/portfolio')
}
