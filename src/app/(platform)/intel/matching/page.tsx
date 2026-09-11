/**
 * /intel/matching — retired, redirects to /intel/identity-review.
 *
 * Wave 3, W24 (2026-09-09). This page listed `client_match_queue`: two
 * panes, person against person and signal against signal. Both queues
 * held the same doubt the spine already records in `candidate_matches`,
 * written by `linkSignal` for every medium and low tier verdict, and
 * adjudicated at /intel/identity-review. Nothing writes
 * `client_match_queue` any more (see migration 400), so this surface
 * would show an empty list for ever.
 *
 * The link stays so old bookmarks, the nav and the internal-link check
 * all resolve. It sends the coordinator to the one queue that is real.
 */

import { redirect } from 'next/navigation'

export default function MatchingRedirectPage() {
  redirect('/intel/identity-review')
}
