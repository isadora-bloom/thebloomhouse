import { redirect } from 'next/navigation'
import { getPlatformRole } from '@/lib/auth/get-platform-role'

/**
 * /admin gate. Anchor: Round 2 audit TIER 3 (2026-05-14).
 *
 * Engineering + identity-audit surfaces live here. Operators see
 * none of this in normal use; only org_admin / super_admin reach it.
 * Each page formerly self-guarded (or didn't); now the layout
 * enforces it ahead of any data fetch.
 */
export default async function AdminLayout({
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
