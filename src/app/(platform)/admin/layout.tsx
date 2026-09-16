import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getPlatformRole } from '@/lib/auth/get-platform-role'
import { isPlatformRole } from '@/lib/auth/roles'

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
  // /admin/imports is an operator surface, not an engineering one: the
  // leads page, the CRM-import form and onboarding all send coordinators
  // there ("Import a file"), and E2E-PLAN §26 has the coordinator upload
  // the Dubsado fixture through it. The gate bounced them to / until
  // 2026-09-15. Any platform role may import; everything else under
  // /admin stays elevated-only. The path comes from the middleware's
  // x-pathname header.
  const pathname = (await headers()).get('x-pathname') ?? ''
  const importsSurface = pathname === '/admin/imports' || pathname.startsWith('/admin/imports/')
  const allowed = importsSurface
    ? isPlatformRole(role)
    : role === 'org_admin' || role === 'super_admin'
  if (!allowed) {
    redirect('/')
  }
  return <>{children}</>
}
