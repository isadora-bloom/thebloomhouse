import { createServiceClient } from '@/lib/supabase/service'
import { getFontUrl, getFontVars } from '@/config/fonts'
import { CoupleShell } from '@/components/couple/couple-shell'
import { PortalReadOnlyNotice } from '@/components/couple/portal-read-only-notice'
import { isVenueFrozen } from '@/lib/services/billing/venue-freeze'
import { FloatingSage } from '@/components/couple/floating-sage'
import { CoupleAiNameProvider } from '@/lib/hooks/use-couple-context'
import { formatBloomNumber } from '@/lib/bloom-number/format'
import { getWeddingRecord } from '@/lib/intel/readers/wedding-record'

/**
 * Layout for path-based couple portal: /couple/[slug]/...
 *
 * This is the dev/demo equivalent of the (couple) route group layout.
 * In production, couples access via subdomain (hawthorne-manor.bloomhouse.ai)
 * which maps to the (couple) route group. In dev/demo, they access via
 * /couple/hawthorne-manor/ which maps here.
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
      clientCode: null as string | null,
      aiName: null as string | null,
    }
  }

  const { data: config } = await supabase
    .from('venue_config')
    .select('primary_color, secondary_color, accent_color, font_pair, logo_url, business_name, portal_tagline')
    .eq('venue_id', venue.id)
    .single()

  // The AI assistant's name, fetched here rather than in a browser effect
  // so the very first paint says what the venue calls theirs. The hook
  // used to default to 'Sage' and correct itself a beat later, which put
  // Bloom's house name in front of another venue's couples on every load.
  const { data: aiConfig } = await supabase
    .from('venue_ai_config')
    .select('ai_name')
    .eq('venue_id', venue.id)
    .maybeSingle()

  // For the demo, resolve the venue's earliest booked/completed couple
  // off the spine — never `weddings` directly — so the top bar's
  // reference code and the Final Review sidebar badge come from the
  // same source `getWeddingRecord` uses everywhere else (W65). Legacy
  // status 'booked' and 'completed' both mirror to lifecycle_state
  // 'booked' (mirror-couple.ts), so this one filter covers what the old
  // `.in('status', ['booked', 'completed'])` query covered. In real use
  // this would be scoped to the currently authenticated couple's
  // wedding_id rather than "earliest for the venue".
  const { data: demoCouple } = await supabase
    .from('couples')
    .select('source_wedding_id')
    .eq('venue_id', venue.id)
    .eq('lifecycle_state', 'booked')
    .is('merged_into_id', null)
    .order('wedding_date', { ascending: true })
    .limit(1)
    .maybeSingle<{ source_wedding_id: string | null }>()

  let clientCode: string | null = null
  let weddingDate: string | null = null
  if (demoCouple?.source_wedding_id) {
    const record = await getWeddingRecord(demoCouple.source_wedding_id, venue.id, supabase)
    weddingDate = record.weddingDate
    const { data: codeRow } = await supabase
      .from('client_codes')
      .select('code')
      .eq('venue_id', venue.id)
      .eq('wedding_id', demoCouple.source_wedding_id)
      .maybeSingle()
    const baseCode = codeRow?.code ?? null
    clientCode = baseCode ? formatBloomNumber(baseCode, record.codeExtension) : null
  }

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
    clientCode,
    weddingDate: weddingDate || null,
    aiName: (aiConfig?.ai_name as string | null | undefined)?.trim() || null,
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
  const frozen = await isVenueFrozen(branding.venueId)
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
      { }
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      { }
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      { }
      <link href={fontUrl} rel="stylesheet" />

      <div style={cssVars} className="min-h-screen bg-[#FAFAF8]">
        {/* Seeds useCoupleContext().aiName so the top bar and the floating
            assistant render the venue's own name on first paint. */}
        <CoupleAiNameProvider aiName={branding.aiName}>
          <CoupleShell
            venueName={branding.venueName}
            logoUrl={branding.logoUrl}
            base={`/couple/${slug}`}
            clientCode={branding.clientCode}
            weddingDate={branding.weddingDate}
          >
            {frozen && <PortalReadOnlyNotice venueName={branding.venueName} />}
            {children}
          </CoupleShell>

          {/* Floating assistant button on every page */}
          {!frozen && <FloatingSage venueSlug={slug} />}
        </CoupleAiNameProvider>
      </div>
    </>
  )
}
