import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Minimal layout for public Sage preview — no auth required
// Loads venue branding (colors, fonts) from slug
// ---------------------------------------------------------------------------

export default async function PreviewLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const supabase = createServiceClient()

  // Load venue branding
  const { data: venue } = await supabase
    .from('venues')
    .select('id, name')
    .eq('slug', slug)
    .single()

  let primaryColor = '#7D8471'
  let secondaryColor = '#5D7A7A'
  let accentColor = '#A6894A'

  if (venue) {
    const { data: config } = await supabase
      .from('venue_config')
      .select('primary_color, secondary_color, accent_color')
      .eq('venue_id', venue.id)
      .single()

    if (config?.primary_color) primaryColor = config.primary_color
    if (config?.secondary_color) secondaryColor = config.secondary_color
    if (config?.accent_color) accentColor = config.accent_color
  }

  return (
    <div
      className="min-h-screen bg-gray-50"
      style={
        {
          '--preview-primary': primaryColor,
          '--preview-secondary': secondaryColor,
          '--preview-accent': accentColor,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  )
}
