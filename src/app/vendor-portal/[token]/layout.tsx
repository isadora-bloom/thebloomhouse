// ---------------------------------------------------------------------------
// Minimal layout for vendor self-service portal — no auth, clean white
// ---------------------------------------------------------------------------

export default function VendorPortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-white">
      {children}
    </div>
  )
}
