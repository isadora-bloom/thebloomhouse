/**
 * Wave 6C — /intel/marketing-roi/recommendations page.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6C: deep-dive view of all
 * reallocation recommendations the Sonnet analyst has produced. Surfaced
 * via the Wave 6B dashboard but lives on its own page so the operator
 * can sift the full status spectrum: Pending / Accepted / Declined /
 * In progress / Completed.)
 *
 * Distinct from /intel/marketing-roi (Wave 6B's heatmap dashboard).
 * That page is for ANALYSING the matrix; this page is for ACTING on it.
 */

import { MarketingRecommendationsDashboard } from '@/components/intel/MarketingRecommendationsDashboard'

export const dynamic = 'force-dynamic'

export default function MarketingRecommendationsPage() {
  return <MarketingRecommendationsDashboard />
}
