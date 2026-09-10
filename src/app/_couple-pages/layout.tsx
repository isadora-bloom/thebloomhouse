import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
import { getFontUrl, getFontVars } from '@/config/fonts'
import { CoupleShell } from '@/components/couple/couple-shell'
import { verifyDemoToken, DEMO_TOKEN_COOKIE } from '@/lib/services/demo-token'
import { CoupleAiNameProvider } from '@/lib/hooks/use-couple-context'
import { FloatingSage } from '@/components/couple/floating-sage'

/**
 * Resolve the venue slug from (in priority order):
 * 1. `venue-slug` cookie set by the middleware (production subdomain routing)
 * 2. `bloom_demo` cookie → 'hawthorne-manor' (demo seed venue)
 *
 * T5-β.4: a missing slug used to silently fall back to 'hawthorne-manor'
 * for local development. That meant a misconfigured production subdomain
 * could route real couples into Hawthorne's portal instead of theirs —
 * a hard-to-detect white-label leak. The fallback now only triggers in
 * demo mode; everything else 404s loudly.
 */
async function resolveVenueSlug(): Promise<string | null> {
  const cookieStore = await cookies()
  const fromCookie = cookieStore.get('venue-slug')?.value
  if (fromCookie) return fromCookie

  // Demo mode is the only context where falling back to a known slug is
  // acceptable. Anywhere else returns null so the caller 404s.
  if (verifyDemoToken(cookieStore.get(DEMO_TOKEN_COOKIE)?.value).ok) return 'hawthorne-manor'

  return null
}

async function getVenueBranding() {
  const slug = await resolveVenueSlug()
  if (!slug) {
    // T5-β.4: refuse to render the couple portal with no resolved
    // venue. Was: fall through to 'hawthorne-manor' and serve another
    // venue's data.
    notFound()
  }
  const supabase = createServiceClient()

  const { data: venue } = await supabase
    .from('venues')
    .select('id, name, slug')
    .eq('slug', slug)
    .single()

  if (!venue) {
    // No venue matches the slug from the cookie — same posture: refuse
    // rather than fall back to a default.
    notFound()
  }

  const { data: config } = await supabase
    .from('venue_config')
    .select('primary_color, secondary_color, accent_color, font_pair, logo_url, business_name, portal_tagline')
    .eq('venue_id', venue.id)
    .single()

  // The AI assistant's name, fetched here rather than in a browser effect
  // so the very first paint says what the venue calls theirs. Without this
  // (W16, 2026-09-09: this layout never queried venue_ai_config, and never
  // wrapped children in CoupleAiNameProvider) useCoupleContext() had nothing
  // seeded and fell through to its own async fetch — a beat where every
  // subdomain-served couple saw the generic 'your AI assistant' fallback
  // before the venue's real name arrived. Mirrors the path-based
  // /couple/[slug] layout, which already does this correctly.
  const { data: aiConfig } = await supabase
    .from('venue_ai_config')
    .select('ai_name')
    .eq('venue_id', venue.id)
    .maybeSingle()

  // Fetch wedding date for the Final Review sidebar badge
  const { data: weddingDateRow } = await supabase
    .from('weddings')
    .select('wedding_date')
    .eq('venue_id', venue.id)
    .in('status', ['booked', 'completed'])
    .order('wedding_date', { ascending: true })
    .limit(1)
    .maybeSingle()

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
    weddingDate: weddingDateRow?.wedding_date || null,
    aiName: (aiConfig?.ai_name as string | null | undefined)?.trim() || null,
  }
}

export default async function CoupleLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const branding = await getVenueBranding()
  const slug = (await resolveVenueSlug()) ?? ''
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
        {/* Seeds useCoupleContext().aiName so every subdomain-served page
            renders the venue's own assistant name on first paint, same as
            the path-based /couple/[slug] layout. */}
        <CoupleAiNameProvider aiName={branding.aiName}>
          <CoupleShell
            venueName={branding.venueName}
            logoUrl={branding.logoUrl}
            base=""
            weddingDate={branding.weddingDate}
          >
            {children}
          </CoupleShell>
          {/* Floating assistant on every page; the path-based layout had it, the
              subdomain layout never did (W16 finding, 2026-09-09). */}
          <FloatingSage venueSlug={slug} />
        </CoupleAiNameProvider>
      </div>
    </>
  )
}
