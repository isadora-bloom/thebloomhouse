import { PlatformShell } from '@/components/shell/platform-shell'

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-warm-white">
      <PlatformShell>{children}</PlatformShell>
    </div>
  )
}
