import { createServiceClient } from '@/lib/supabase/service'
import { getFontUrl, getFontVars } from '@/config/fonts'
import { SlugCoupleNav } from './slug-couple-nav'

/**
 * Layout for path-based couple portal: /couple/[slug]/...
 *
 * This is the dev/demo equivalent of the (couple) route group layout.
 * In production, couples access via subdomain (rixey-manor.bloomhouse.ai)
 * which maps to the (couple) route group. In dev/demo, they access via
 * /couple/rixey-manor/ which maps here.
 *
 * This layout:
 * 1. Extracts the venue slug from the URL
 * 2. Sets a cookie so downstream code can read venue-slug
 * 3. Loads venue_config for branding (colors, fonts, logo)
 * 4. Injects CSS custom properties + Google Fonts
 * 5. Renders the couple nav and children
 */

async function getVenueBranding(slug: string) {
  const supabase = createServiceClient()

  const { data: venue } = await supabase
    .from('venues')
    .select('id, name, slug')
    .eq('slug', slug)
    .single()

  if (!venue) {
    return {
      venueId: '',
      venueSlug: slug,
      venueName: 'Wedding Portal',
      primaryColor: '#7D8471',
      secondaryColor: '#5D7A7A',
      accentColor: '#A6894A',
      fontPairKey: 'playfair_inter',
      logoUrl: null as string | null,
      portalTagline: null as string | null,
    }
  }

  const { data: config } = await supabase
    .from('venue_config')
    .select('primary_color, secondary_color, accent_color, font_pair, logo_url, business_name, portal_tagline')
    .eq('venue_id', venue.id)
    .single()

  return {
    venueId: venue.id,
    venueSlug: venue.slug,
    venueName: config?.business_name || venue.name,
    primaryColor: config?.primary_color || '#7D8471',
    secondaryColor: config?.secondary_color || '#5D7A7A',
    accentColor: config?.accent_color || '#A6894A',
    fontPairKey: config?.font_pair || 'playfair_inter',
    logoUrl: config?.logo_url || null,
    portalTagline: config?.portal_tagline || null,
  }
}

export default async function CoupleSlugLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  // Note: We don't set cookies in layouts (not allowed in server components).
  // The middleware handles cookie setting. The slug comes from URL params.

  const branding = await getVenueBranding(slug)
  const fontUrl = getFontUrl(branding.fontPairKey)
  const fontVars = getFontVars(branding.fontPairKey)

  const cssVars = {
    '--couple-primary': branding.primaryColor,
    '--couple-secondary': branding.secondaryColor,
    '--couple-accent': branding.accentColor,
    '--couple-font-heading': fontVars.heading,
    '--couple-font-body': fontVars.body,
  } as React.CSSProperties

  return (
    <>
      {/* Google Fonts for venue font pair */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link href={fontUrl} rel="stylesheet" />

      <div style={cssVars} className="min-h-screen bg-[#FAFAF8]">
        <SlugCoupleNav
          venueName={branding.venueName}
          logoUrl={branding.logoUrl}
          venueSlug={slug}
        />

        {/* Main content — offset for fixed nav */}
        <main className="pt-16 lg:pt-16">
          <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </>
  )
}
