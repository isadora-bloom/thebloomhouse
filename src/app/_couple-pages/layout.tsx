import { cookies } from 'next/headers'
import { createServiceClient } from '@/lib/supabase/service'
import { getFontUrl, getFontVars } from '@/config/fonts'
import { CoupleNav } from './couple-nav'

/**
 * Resolve the venue slug from (in priority order):
 * 1. `venue-slug` cookie set by the middleware (production subdomain routing)
 * 2. `?venue=` search param (dev convenience)
 * 3. Fallback to 'rixey-manor' for local development
 */
async function resolveVenueSlug(): Promise<string> {
  const cookieStore = await cookies()
  const fromCookie = cookieStore.get('venue-slug')?.value
  if (fromCookie) return fromCookie

  // Fallback for development — hardcoded default
  return 'rixey-manor'
}

async function getVenueBranding() {
  const slug = await resolveVenueSlug()
  const supabase = createServiceClient()

  const { data: venue } = await supabase
    .from('venues')
    .select('id, name, slug')
    .eq('slug', slug)
    .single()

  if (!venue) {
    return {
      venueId: '',
      venueName: 'Wedding Portal',
      primaryColor: '#7D8471',
      secondaryColor: '#5D7A7A',
      accentColor: '#A6894A',
      fontPairKey: 'playfair_inter',
      logoUrl: null as string | null,
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

export default async function CoupleLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const branding = await getVenueBranding()
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
        <CoupleNav venueName={branding.venueName} logoUrl={branding.logoUrl} />

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
