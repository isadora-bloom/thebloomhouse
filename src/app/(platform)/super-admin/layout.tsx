import { redirect } from 'next/navigation'
import { getPlatformRole } from '@/lib/auth/get-platform-role'

/**
 * /super-admin gate. Anchor: Round 2 audit TIER 3 (2026-05-14).
 *
 * Platform-team-only views (cross-org venue list, observability,
 * pipeline health, consumer-requests). Org admins do NOT belong
 * here — they get /admin. Only super_admin passes the gate.
 */
export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const role = await getPlatformRole()
  if (role !== 'super_admin') {
    redirect('/')
  }
  return <>{children}</>
}
