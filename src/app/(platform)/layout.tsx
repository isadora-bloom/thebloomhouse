import { redirect } from 'next/navigation'
import { PlatformShell } from '@/components/shell/platform-shell'
import { VenueScopeProvider } from '@/lib/contexts/venue-scope-context'
import { resolvePlatformScope } from '@/lib/api/resolve-platform-scope'

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Resolve venue SERVER-SIDE before any child page renders. See
  // resolve-platform-scope.ts for the resolution order. If nothing
  // matches, middleware should already have sent unauthed users to
  // /login; an authed user with no venue goes to /setup.
  const scope = await resolvePlatformScope()
  if (!scope) redirect('/setup')

  return (
    <VenueScopeProvider
      venueId={scope.venueId}
      orgId={scope.orgId}
      venueName={scope.venueName}
      orgName={scope.orgName}
    >
      <div className="min-h-screen bg-warm-white">
        <PlatformShell>{children}</PlatformShell>
      </div>
    </VenueScopeProvider>
  )
}
