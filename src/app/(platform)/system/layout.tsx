import { redirect } from 'next/navigation'
import { getPlatformRole } from '@/lib/auth/get-platform-role'

/**
 * /system gate — operator-trust surfaces.
 *
 * Anchor: PHASE-1-BATCH-2.md §7 "Operator-facing additions" item 2,
 * and bloom-consolidation-checkpoint "Open critical findings …
 * OPERATOR-BLOCK §7 items 0/5 shipped".
 *
 * /system is the narrow surface where Batch 2 (and any future
 * phased migration) tells the operator which channels have moved
 * vs which still write to the legacy path. Without it, during the
 * 2-3 week phase A→B→C window every weird number on /intel looks
 * like a real bug — there is no way to distinguish migration
 * artefact from regression.
 *
 * Same gate as /admin (org_admin / super_admin only). Coordinators
 * never see this surface — by design; the vocabulary is engineering.
 * If we ever want to surface a coordinator-facing "consolidation in
 * flight" disclosure, that belongs in a separate, plain-language
 * route, not here.
 */
export default async function SystemLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const role = await getPlatformRole()
  if (role !== 'org_admin' && role !== 'super_admin') {
    redirect('/')
  }
  return <>{children}</>
}
