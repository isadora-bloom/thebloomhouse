/**
 * Wave 6B — /intel/marketing-roi page.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6B: dashboard surfaces the
 * persona × channel heatmap + top-line metrics + biggest disparities).
 *
 * Distinct from /intel/marketing-spend (Wave 6A's manual entry form).
 * That page is for INPUT (recording spend); this page is for OUTPUT
 * (analysing ROI per persona per channel).
 */

import { MarketingRoiDashboard } from '@/components/intel/MarketingRoiDashboard'

export const dynamic = 'force-dynamic'

export default function MarketingRoiPage() {
  return <MarketingRoiDashboard />
}
