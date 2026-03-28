'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Heart,
  MapPin,
  Clock,
  ChevronDown,
  Gift,
  HelpCircle,
  Users,
  Camera,
  Car,
  Hotel,
  Utensils,
  CheckCircle2,
  AlertCircle,
  Search,
  ExternalLink,
  Loader2,
  Sparkles,
} from 'lucide-react'
import { useParams } from 'next/navigation'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ThemeName = 'classic' | 'modern' | 'garden' | 'romantic' | 'rustic'

interface WebsiteSection {
  id: string
  type: string
  enabled: boolean
  sort_order: number
  data: Record<string, unknown>
}

interface WebsiteData {
  slug: string
  theme: ThemeName
  accent_color: string
  couple_names: string | null
  partner1_name: string
  partner2_name: string
  wedding_date: string
  venue_name: string
  venue_address: string
  sections_order: string[]
  sections_enabled: Record<string, boolean>
  sections: WebsiteSection[]
  our_story: string | null
  dress_code: string | null
  registry_links: RegistryLink[]
  faq: FAQItem[]
  things_to_do: ThingsToDoItem[]
}

interface FAQItem {
  question: string
  answer: string
}

interface RegistryLink {
  name: string
  url: string
  icon?: string
}

interface ThingsToDoItem {
  name: string
  category: string
  description: string
  url?: string
}

interface MealOption {
  id: string
  option_name: string
  description: string | null
}

interface TimelineItem {
  id: string
  title: string
  description: string | null
  start_time: string | null
  end_time: string | null
  type: string
  sort_order: number
}

interface Accommodation {
  id: string
  name: string
  description: string | null
  address: string | null
  phone: string | null
  website_url: string | null
  distance_miles: number | null
  price_range: string | null
  block_code: string | null
  block_deadline: string | null
  notes: string | null
}

interface GuestSearchResult {
  guest_id: string
  name: string
  group_name: string | null
  rsvp_status: string
  plus_one: boolean
}

// ---------------------------------------------------------------------------
// Theme configs
// ---------------------------------------------------------------------------

const THEME_CONFIG: Record<ThemeName, {
  bg: string
  sectionBg: string
  headingFont: string
  bodyFont: string
  textColor: string
  mutedColor: string
  borderColor: string
}> = {
  classic: {
    bg: '#FAF8F5',
    sectionBg: '#FFFFFF',
    headingFont: "'Playfair Display', 'Georgia', serif",
    bodyFont: "'Inter', 'Georgia', serif",
    textColor: '#3D3D3D',
    mutedColor: '#8A8A8A',
    borderColor: '#E8E4DF',
  },
  modern: {
    bg: '#FAFAFA',
    sectionBg: '#FFFFFF',
    headingFont: "'Inter', 'Helvetica Neue', sans-serif",
    bodyFont: "'Inter', 'Helvetica Neue', sans-serif",
    textColor: '#1A1A1A',
    mutedColor: '#6B6B6B',
    borderColor: '#E5E5E5',
  },
  garden: {
    bg: '#F5F9F5',
    sectionBg: '#FFFFFF',
    headingFont: "'Playfair Display', 'Georgia', serif",
    bodyFont: "'Inter', 'Georgia', serif",
    textColor: '#2D3B2D',
    mutedColor: '#6B7B6B',
    borderColor: '#D4E4D4',
  },
  romantic: {
    bg: '#FDF5F3',
    sectionBg: '#FFFFFF',
    headingFont: "'Playfair Display', 'Georgia', serif",
    bodyFont: "'Inter', 'Georgia', serif",
    textColor: '#4A3540',
    mutedColor: '#9A7B8A',
    borderColor: '#E8D8DF',
  },
  rustic: {
    bg: '#F9F6F1',
    sectionBg: '#FFFFFF',
    headingFont: "'Playfair Display', 'Georgia', serif",
    bodyFont: "'Inter', 'Georgia', serif",
    textColor: '#3D3428',
    mutedColor: '#8A7B6B',
    borderColor: '#E0D8CB',
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T12:00:00')
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function formatTime(timeStr: string): string {
  try {
    const [h, m] = timeStr.split(':')
    const hour = parseInt(h, 10)
    const ampm = hour >= 12 ? 'PM' : 'AM'
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
    return `${h12}:${m} ${ampm}`
  } catch {
    return timeStr
  }
}

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `${r}, ${g}, ${b}`
}

function getSectionFromSections(sections: WebsiteSection[], type: string): WebsiteSection | undefined {
  return sections.find(s => s.type === type)
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function WeddingWebsitePage() {
  const params = useParams()
  const slug = params.slug as string

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [website, setWebsite] = useState<WebsiteData | null>(null)
  const [mealOptions, setMealOptions] = useState<MealOption[]>([])
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [accommodations, setAccommodations] = useState<Accommodation[]>([])
  const [eventDate, setEventDate] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`/api/public/wedding-website?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Website not found')
      }
      const data = await res.json()
      setWebsite(data.website)
      setMealOptions(data.meal_options ?? [])
      setTimeline(data.timeline ?? [])
      setAccommodations(data.accommodations ?? [])
      setEventDate(data.event_date ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => {
    if (slug) fetchData()
  }, [slug, fetchData])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#FAF8F5' }}>
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-gray-400" />
          <p className="text-sm text-gray-400">Loading wedding website...</p>
        </div>
      </div>
    )
  }

  if (error || !website) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#FAF8F5' }}>
        <div className="text-center space-y-4 max-w-md px-6">
          <Heart className="w-12 h-12 mx-auto text-gray-300" />
          <h1 className="text-2xl font-light text-gray-600" style={{ fontFamily: "'Playfair Display', serif" }}>
            {error === 'Wedding website not found or not published'
              ? 'This wedding website is not available'
              : 'Something went wrong'}
          </h1>
          <p className="text-sm text-gray-400">
            {error === 'Wedding website not found or not published'
              ? 'The page may have been unpublished or the link may be incorrect.'
              : error}
          </p>
        </div>
      </div>
    )
  }

  const theme = THEME_CONFIG[website.theme] || THEME_CONFIG.classic
  const accent = website.accent_color || '#8B7355'
  const accentRgb = hexToRgb(accent)

  // Build ordered list of enabled sections
  const sections = (website.sections || [])
    .filter(s => s.enabled)
    .sort((a, b) => a.sort_order - b.sort_order)

  const coupleNames = website.partner1_name && website.partner2_name
    ? `${website.partner1_name} & ${website.partner2_name}`
    : website.couple_names || 'Our Wedding'

  const weddingDate = website.wedding_date || eventDate

  return (
    <div style={{ backgroundColor: theme.bg, color: theme.textColor, fontFamily: theme.bodyFont }}>
      {/* ================================================================= */}
      {/* HERO */}
      {/* ================================================================= */}
      <section className="relative py-20 sm:py-28 md:py-36 px-6 text-center">
        <div className="max-w-2xl mx-auto space-y-6">
          <p
            className="text-[11px] sm:text-xs uppercase tracking-[0.35em] font-medium"
            style={{ color: accent }}
          >
            Together with their families
          </p>

          <h1
            className="text-4xl sm:text-5xl md:text-6xl font-light leading-tight"
            style={{ fontFamily: theme.headingFont, color: accent }}
          >
            {coupleNames}
          </h1>

          <div className="w-20 h-px mx-auto" style={{ backgroundColor: accent }} />

          {weddingDate && (
            <p className="text-base sm:text-lg" style={{ color: theme.mutedColor }}>
              {formatDate(weddingDate)}
            </p>
          )}

          {website.venue_name && (
            <p className="text-sm" style={{ color: theme.mutedColor }}>
              {website.venue_name}
              {website.venue_address && (
                <span className="block mt-1 text-xs">{website.venue_address}</span>
              )}
            </p>
          )}

          {/* Countdown */}
          {weddingDate && <CountdownDisplay dateStr={weddingDate} accent={accent} muted={theme.mutedColor} />}
        </div>

        {/* Scroll indicator */}
        {sections.length > 0 && (
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
            <ChevronDown className="w-5 h-5" style={{ color: accent, opacity: 0.4 }} />
          </div>
        )}
      </section>

      {/* ================================================================= */}
      {/* SECTIONS (rendered in user-defined order) */}
      {/* ================================================================= */}
      {sections.map((section) => (
        <SectionRenderer
          key={section.type}
          section={section}
          website={website}
          theme={theme}
          accent={accent}
          accentRgb={accentRgb}
          mealOptions={mealOptions}
          timeline={timeline}
          accommodations={accommodations}
          slug={slug}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

function CountdownDisplay({ dateStr, accent, muted }: { dateStr: string; accent: string; muted: string }) {
  const [days, setDays] = useState<number | null>(null)

  useEffect(() => {
    const target = new Date(dateStr + 'T12:00:00').getTime()
    const now = Date.now()
    const diff = Math.ceil((target - now) / (1000 * 60 * 60 * 24))
    setDays(diff)
  }, [dateStr])

  if (days === null) return null
  if (days < 0) return null
  if (days === 0) {
    return (
      <p className="text-sm font-medium mt-4" style={{ color: accent }}>
        Today is the day!
      </p>
    )
  }

  return (
    <p className="text-xs mt-4" style={{ color: muted }}>
      <span className="font-semibold text-sm" style={{ color: accent }}>{days}</span>{' '}
      {days === 1 ? 'day' : 'days'} to go
    </p>
  )
}

// ---------------------------------------------------------------------------
// Section Router
// ---------------------------------------------------------------------------

function SectionRenderer({
  section,
  website,
  theme,
  accent,
  accentRgb,
  mealOptions,
  timeline,
  accommodations,
  slug,
}: {
  section: WebsiteSection
  website: WebsiteData
  theme: typeof THEME_CONFIG.classic
  accent: string
  accentRgb: string
  mealOptions: MealOption[]
  timeline: TimelineItem[]
  accommodations: Accommodation[]
  slug: string
}) {
  const content = (() => {
    switch (section.type) {
      case 'our_story':
        return <OurStorySection data={section.data} website={website} theme={theme} accent={accent} />
      case 'wedding_party':
        return <WeddingPartySection data={section.data} theme={theme} accent={accent} />
      case 'photo_gallery':
        return <GallerySection data={section.data} theme={theme} accent={accent} />
      case 'the_day':
        return <ScheduleSection data={section.data} timeline={timeline} theme={theme} accent={accent} />
      case 'rsvp':
        return <RSVPSection data={section.data} slug={slug} mealOptions={mealOptions} theme={theme} accent={accent} accentRgb={accentRgb} />
      case 'registry':
        return <RegistrySection data={section.data} website={website} theme={theme} accent={accent} accentRgb={accentRgb} />
      case 'faq':
        return <FAQSection data={section.data} website={website} theme={theme} accent={accent} />
      case 'things_to_do':
        return <ThingsToDoSection data={section.data} website={website} theme={theme} accent={accent} />
      case 'dress_code':
        return <DressCodeSection data={section.data} website={website} theme={theme} accent={accent} />
      case 'transportation':
        return <TransportationSection data={section.data} theme={theme} accent={accent} />
      case 'nearby_stays':
        return <AccommodationsSection data={section.data} accommodations={accommodations} theme={theme} accent={accent} accentRgb={accentRgb} />
      default:
        return null
    }
  })()

  if (!content) return null

  return (
    <section className="py-16 sm:py-20 px-6">
      <div className="max-w-3xl mx-auto">
        {content}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Section heading helper
// ---------------------------------------------------------------------------

function SectionHeading({ title, icon: Icon, accent, headingFont }: {
  title: string
  icon?: React.ElementType
  accent: string
  headingFont: string
}) {
  return (
    <div className="text-center mb-10 sm:mb-12">
      {Icon && <Icon className="w-5 h-5 mx-auto mb-3" style={{ color: accent, opacity: 0.6 }} />}
      <h2
        className="text-2xl sm:text-3xl font-light"
        style={{ fontFamily: headingFont, color: accent }}
      >
        {title}
      </h2>
      <div className="w-12 h-px mx-auto mt-4" style={{ backgroundColor: accent, opacity: 0.3 }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// OUR STORY
// ---------------------------------------------------------------------------

function OurStorySection({ data, website, theme, accent }: {
  data: Record<string, unknown>
  website: WebsiteData
  theme: typeof THEME_CONFIG.classic
  accent: string
}) {
  const text = (data.text as string) || website.our_story || ''
  if (!text) return null

  return (
    <>
      <SectionHeading title="Our Story" icon={Heart} accent={accent} headingFont={theme.headingFont} />
      <div className="max-w-xl mx-auto">
        <p
          className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap text-center"
          style={{ color: theme.textColor, lineHeight: '1.8' }}
        >
          {text}
        </p>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// WEDDING PARTY
// ---------------------------------------------------------------------------

function WeddingPartySection({ data, theme, accent }: {
  data: Record<string, unknown>
  theme: typeof THEME_CONFIG.classic
  accent: string
}) {
  const members = (data.members as Array<{ name: string; role: string; description?: string }>) || []
  if (members.length === 0) return null

  return (
    <>
      <SectionHeading title="Wedding Party" icon={Users} accent={accent} headingFont={theme.headingFont} />
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-6 sm:gap-8">
        {members.filter(m => m.name).map((member, i) => (
          <div key={i} className="text-center space-y-2">
            <div
              className="w-20 h-20 sm:w-24 sm:h-24 rounded-full mx-auto flex items-center justify-center"
              style={{ backgroundColor: accent + '15' }}
            >
              <span className="text-2xl sm:text-3xl font-light" style={{ color: accent, fontFamily: theme.headingFont }}>
                {member.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <p className="text-sm font-medium" style={{ color: theme.textColor }}>{member.name}</p>
            <p className="text-xs" style={{ color: theme.mutedColor }}>{member.role}</p>
            {member.description && (
              <p className="text-xs leading-relaxed" style={{ color: theme.mutedColor }}>{member.description}</p>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// GALLERY
// ---------------------------------------------------------------------------

function GallerySection({ data, theme, accent }: {
  data: Record<string, unknown>
  theme: typeof THEME_CONFIG.classic
  accent: string
}) {
  const photos = ((data.photos as string[]) || []).filter(Boolean)
  if (photos.length === 0) return null

  return (
    <>
      <SectionHeading title="Gallery" icon={Camera} accent={accent} headingFont={theme.headingFont} />
      <div className={`grid gap-3 sm:gap-4 ${
        photos.length === 1 ? 'grid-cols-1 max-w-lg mx-auto' :
        photos.length === 2 ? 'grid-cols-2' :
        photos.length <= 4 ? 'grid-cols-2' :
        'grid-cols-2 sm:grid-cols-3'
      }`}>
        {photos.map((url, i) => (
          <div
            key={i}
            className="relative aspect-square rounded-lg overflow-hidden group"
            style={{ backgroundColor: theme.borderColor }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`Wedding photo ${i + 1}`}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            />
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// SCHEDULE / THE DAY
// ---------------------------------------------------------------------------

function ScheduleSection({ data, timeline, theme, accent }: {
  data: Record<string, unknown>
  timeline: TimelineItem[]
  theme: typeof THEME_CONFIG.classic
  accent: string
}) {
  const ceremonyTime = data.ceremony_time as string
  const receptionTime = data.reception_time as string
  const details = data.details as string

  const hasTimeline = timeline.length > 0
  const hasBasic = ceremonyTime || receptionTime || details

  if (!hasTimeline && !hasBasic) return null

  return (
    <>
      <SectionHeading title="The Day" icon={Clock} accent={accent} headingFont={theme.headingFont} />

      {/* Basic ceremony/reception times */}
      {hasBasic && (
        <div className="max-w-md mx-auto space-y-4 text-center mb-8">
          {ceremonyTime && (
            <div>
              <p className="text-xs uppercase tracking-wider font-medium mb-1" style={{ color: accent }}>Ceremony</p>
              <p className="text-lg" style={{ color: theme.textColor }}>{formatTime(ceremonyTime)}</p>
            </div>
          )}
          {receptionTime && (
            <div>
              <p className="text-xs uppercase tracking-wider font-medium mb-1" style={{ color: accent }}>Reception</p>
              <p className="text-lg" style={{ color: theme.textColor }}>{formatTime(receptionTime)}</p>
            </div>
          )}
          {details && (
            <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: theme.mutedColor }}>
              {details}
            </p>
          )}
        </div>
      )}

      {/* Full timeline */}
      {hasTimeline && (
        <div className="max-w-md mx-auto space-y-0">
          {timeline.map((item, i) => (
            <div key={item.id} className="flex gap-4 py-4">
              {/* Timeline dot & line */}
              <div className="flex flex-col items-center">
                <div className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: accent }} />
                {i < timeline.length - 1 && (
                  <div className="w-px flex-1 mt-1" style={{ backgroundColor: accent + '25' }} />
                )}
              </div>

              {/* Content */}
              <div className="pb-2">
                {item.start_time && (
                  <p className="text-xs font-medium mb-0.5" style={{ color: accent }}>
                    {formatTime(item.start_time)}
                    {item.end_time && <span> - {formatTime(item.end_time)}</span>}
                  </p>
                )}
                <p className="text-sm font-medium" style={{ color: theme.textColor }}>{item.title}</p>
                {item.description && (
                  <p className="text-xs mt-1 leading-relaxed" style={{ color: theme.mutedColor }}>{item.description}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// RSVP
// ---------------------------------------------------------------------------

type RSVPStep = 'search' | 'confirm' | 'form' | 'success'

function RSVPSection({ data, slug, mealOptions, theme, accent, accentRgb }: {
  data: Record<string, unknown>
  slug: string
  mealOptions: MealOption[]
  theme: typeof THEME_CONFIG.classic
  accent: string
  accentRgb: string
}) {
  const [step, setStep] = useState<RSVPStep>('search')
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<GuestSearchResult[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [selectedGuest, setSelectedGuest] = useState<GuestSearchResult | null>(null)

  const [rsvpStatus, setRsvpStatus] = useState<'attending' | 'declined'>('attending')
  const [mealChoice, setMealChoice] = useState('')
  const [dietary, setDietary] = useState('')
  const [plusOneRsvp, setPlusOneRsvp] = useState<'attending' | 'declined'>('attending')
  const [plusOneName, setPlusOneName] = useState('')
  const [plusOneMeal, setPlusOneMeal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const deadlineEnabled = data.deadline_enabled as boolean
  const deadline = data.deadline as string
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Check if past deadline
  const isPastDeadline = (() => {
    if (!deadlineEnabled || !deadline) return false
    return new Date(deadline + 'T23:59:59') < new Date()
  })()

  async function handleSearch() {
    if (searchQuery.trim().length < 2) return
    setSearching(true)
    setSearchError(null)
    setSearchResults([])

    try {
      const res = await fetch(
        `/api/public/wedding-website?slug=${encodeURIComponent(slug)}&action=search_guest&name=${encodeURIComponent(searchQuery.trim())}`
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')

      if (data.guests.length === 0) {
        setSearchError('We could not find your name on the guest list. Please check the spelling or contact the couple.')
      } else {
        setSearchResults(data.guests)
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  function selectGuest(guest: GuestSearchResult) {
    setSelectedGuest(guest)
    setStep('confirm')
  }

  function confirmGuest() {
    setStep('form')
  }

  async function submitRSVP() {
    if (!selectedGuest) return
    setSubmitting(true)
    setSubmitError(null)

    try {
      const body: Record<string, unknown> = {
        guest_id: selectedGuest.guest_id,
        rsvp_status: rsvpStatus,
      }

      if (rsvpStatus === 'attending') {
        if (mealChoice) body.meal_preference = mealChoice
        if (dietary) body.dietary_restrictions = dietary
      }

      if (selectedGuest.plus_one) {
        body.plus_one_rsvp = plusOneRsvp
        if (plusOneName) body.plus_one_name = plusOneName
        if (plusOneRsvp === 'attending' && plusOneMeal) body.plus_one_meal = plusOneMeal
      }

      const res = await fetch(
        `/api/public/wedding-website?slug=${encodeURIComponent(slug)}&action=rsvp`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to submit RSVP')

      setStep('success')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    borderColor: theme.borderColor,
    color: theme.textColor,
    fontFamily: theme.bodyFont,
  }

  const inputClass = 'w-full px-4 py-3 border rounded-lg text-sm focus:outline-none focus:ring-2 transition-colors bg-white'

  return (
    <>
      <SectionHeading title="RSVP" icon={CheckCircle2} accent={accent} headingFont={theme.headingFont} />

      {deadlineEnabled && deadline && (
        <p className="text-center text-xs mb-6" style={{ color: theme.mutedColor }}>
          {isPastDeadline
            ? 'The RSVP deadline has passed.'
            : `Please respond by ${formatDate(deadline)}`}
        </p>
      )}

      {isPastDeadline ? (
        <div className="text-center py-6">
          <AlertCircle className="w-8 h-8 mx-auto mb-3" style={{ color: theme.mutedColor }} />
          <p className="text-sm" style={{ color: theme.mutedColor }}>
            The RSVP window has closed. Please contact the couple directly.
          </p>
        </div>
      ) : (
        <div className="max-w-md mx-auto">
          {/* ---- Search Step ---- */}
          {step === 'search' && (
            <div className="space-y-4">
              <p className="text-sm text-center mb-6" style={{ color: theme.mutedColor }}>
                Find your name to respond
              </p>
              <div className="relative">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="Enter your first and last name"
                  className={inputClass}
                  style={{ ...inputStyle, '--tw-ring-color': accent } as React.CSSProperties}
                />
                <button
                  onClick={handleSearch}
                  disabled={searching || searchQuery.trim().length < 2}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-md transition-colors disabled:opacity-40"
                  style={{ color: accent }}
                >
                  {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                </button>
              </div>

              {searchError && (
                <p className="text-xs text-center" style={{ color: '#B45454' }}>{searchError}</p>
              )}

              {searchResults.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium" style={{ color: theme.mutedColor }}>Select your name:</p>
                  {searchResults.map((guest) => (
                    <button
                      key={guest.guest_id}
                      onClick={() => selectGuest(guest)}
                      className="w-full text-left px-4 py-3 rounded-lg border transition-colors hover:border-current"
                      style={{
                        borderColor: theme.borderColor,
                        color: theme.textColor,
                      }}
                    >
                      <p className="text-sm font-medium">{guest.name}</p>
                      {guest.group_name && (
                        <p className="text-xs mt-0.5" style={{ color: theme.mutedColor }}>{guest.group_name}</p>
                      )}
                      {guest.rsvp_status && guest.rsvp_status !== 'pending' && (
                        <p className="text-[10px] mt-1" style={{ color: accent }}>
                          Previously responded: {guest.rsvp_status}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---- Confirm Step ---- */}
          {step === 'confirm' && selectedGuest && (
            <div className="text-center space-y-6">
              <div
                className="inline-block px-6 py-4 rounded-xl"
                style={{ backgroundColor: accent + '10' }}
              >
                <p className="text-sm" style={{ color: theme.mutedColor }}>Responding as</p>
                <p className="text-lg font-medium mt-1" style={{ color: accent, fontFamily: theme.headingFont }}>
                  {selectedGuest.name}
                </p>
                {selectedGuest.group_name && (
                  <p className="text-xs mt-1" style={{ color: theme.mutedColor }}>{selectedGuest.group_name}</p>
                )}
              </div>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => { setStep('search'); setSelectedGuest(null); setSearchResults([]) }}
                  className="px-5 py-2.5 rounded-lg text-sm border transition-colors hover:bg-gray-50"
                  style={{ borderColor: theme.borderColor, color: theme.mutedColor }}
                >
                  Not me
                </button>
                <button
                  onClick={confirmGuest}
                  className="px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: accent }}
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ---- RSVP Form ---- */}
          {step === 'form' && selectedGuest && (
            <div className="space-y-6">
              <p className="text-sm text-center" style={{ color: theme.mutedColor }}>
                {selectedGuest.name}
              </p>

              {/* Attending? */}
              <div className="space-y-2">
                <label className="block text-xs font-medium" style={{ color: theme.textColor }}>
                  Will you be attending?
                </label>
                <div className="grid grid-cols-2 gap-3">
                  {(['attending', 'declined'] as const).map((status) => (
                    <button
                      key={status}
                      onClick={() => setRsvpStatus(status)}
                      className="px-4 py-3 rounded-lg border-2 text-sm font-medium transition-all"
                      style={{
                        borderColor: rsvpStatus === status ? accent : theme.borderColor,
                        backgroundColor: rsvpStatus === status ? accent + '10' : 'transparent',
                        color: rsvpStatus === status ? accent : theme.mutedColor,
                      }}
                    >
                      {status === 'attending' ? 'Joyfully Accept' : 'Respectfully Decline'}
                    </button>
                  ))}
                </div>
              </div>

              {rsvpStatus === 'attending' && (
                <>
                  {/* Meal preference */}
                  {mealOptions.length > 0 && (
                    <div className="space-y-2">
                      <label className="block text-xs font-medium" style={{ color: theme.textColor }}>
                        <Utensils className="w-3 h-3 inline mr-1" />
                        Meal Preference
                      </label>
                      <div className="space-y-2">
                        {mealOptions.map((opt) => (
                          <button
                            key={opt.id}
                            onClick={() => setMealChoice(opt.option_name)}
                            className="w-full text-left px-4 py-3 rounded-lg border-2 transition-all"
                            style={{
                              borderColor: mealChoice === opt.option_name ? accent : theme.borderColor,
                              backgroundColor: mealChoice === opt.option_name ? accent + '10' : 'transparent',
                            }}
                          >
                            <p className="text-sm font-medium" style={{ color: mealChoice === opt.option_name ? accent : theme.textColor }}>
                              {opt.option_name}
                            </p>
                            {opt.description && (
                              <p className="text-xs mt-0.5" style={{ color: theme.mutedColor }}>{opt.description}</p>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Dietary restrictions */}
                  <div className="space-y-2">
                    <label className="block text-xs font-medium" style={{ color: theme.textColor }}>
                      Dietary Restrictions or Allergies
                    </label>
                    <textarea
                      value={dietary}
                      onChange={(e) => setDietary(e.target.value)}
                      placeholder="Any dietary needs we should know about?"
                      rows={2}
                      className={`${inputClass} resize-none`}
                      style={{ ...inputStyle, '--tw-ring-color': accent } as React.CSSProperties}
                    />
                  </div>
                </>
              )}

              {/* Plus one */}
              {selectedGuest.plus_one && (
                <div className="space-y-4 pt-4" style={{ borderTop: `1px solid ${theme.borderColor}` }}>
                  <p className="text-xs font-medium uppercase tracking-wider" style={{ color: accent }}>
                    Plus One
                  </p>

                  <div className="space-y-2">
                    <label className="block text-xs font-medium" style={{ color: theme.textColor }}>
                      Guest Name
                    </label>
                    <input
                      type="text"
                      value={plusOneName}
                      onChange={(e) => setPlusOneName(e.target.value)}
                      placeholder="Your guest's full name"
                      className={inputClass}
                      style={{ ...inputStyle, '--tw-ring-color': accent } as React.CSSProperties}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="block text-xs font-medium" style={{ color: theme.textColor }}>
                      Will they be attending?
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      {(['attending', 'declined'] as const).map((status) => (
                        <button
                          key={status}
                          onClick={() => setPlusOneRsvp(status)}
                          className="px-4 py-2.5 rounded-lg border-2 text-sm transition-all"
                          style={{
                            borderColor: plusOneRsvp === status ? accent : theme.borderColor,
                            backgroundColor: plusOneRsvp === status ? accent + '10' : 'transparent',
                            color: plusOneRsvp === status ? accent : theme.mutedColor,
                          }}
                        >
                          {status === 'attending' ? 'Yes' : 'No'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {plusOneRsvp === 'attending' && mealOptions.length > 0 && (
                    <div className="space-y-2">
                      <label className="block text-xs font-medium" style={{ color: theme.textColor }}>
                        Their Meal Preference
                      </label>
                      <div className="space-y-2">
                        {mealOptions.map((opt) => (
                          <button
                            key={opt.id}
                            onClick={() => setPlusOneMeal(opt.option_name)}
                            className="w-full text-left px-4 py-2.5 rounded-lg border-2 transition-all"
                            style={{
                              borderColor: plusOneMeal === opt.option_name ? accent : theme.borderColor,
                              backgroundColor: plusOneMeal === opt.option_name ? accent + '10' : 'transparent',
                            }}
                          >
                            <p className="text-sm" style={{ color: plusOneMeal === opt.option_name ? accent : theme.textColor }}>
                              {opt.option_name}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {submitError && (
                <p className="text-xs text-center" style={{ color: '#B45454' }}>{submitError}</p>
              )}

              {/* Submit */}
              <div className="flex items-center justify-center gap-3 pt-2">
                <button
                  onClick={() => setStep('search')}
                  className="px-5 py-2.5 rounded-lg text-sm border transition-colors hover:bg-gray-50"
                  style={{ borderColor: theme.borderColor, color: theme.mutedColor }}
                >
                  Back
                </button>
                <button
                  onClick={submitRSVP}
                  disabled={submitting}
                  className="px-8 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  style={{ backgroundColor: accent }}
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                  ) : (
                    'Submit RSVP'
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ---- Success ---- */}
          {step === 'success' && (
            <div className="text-center space-y-4 py-6">
              <div className="w-16 h-16 rounded-full mx-auto flex items-center justify-center" style={{ backgroundColor: accent + '15' }}>
                <CheckCircle2 className="w-8 h-8" style={{ color: accent }} />
              </div>
              <h3 className="text-xl font-light" style={{ fontFamily: theme.headingFont, color: accent }}>
                {rsvpStatus === 'attending' ? 'See you there!' : 'Thank you for letting us know'}
              </h3>
              <p className="text-sm" style={{ color: theme.mutedColor }}>
                {rsvpStatus === 'attending'
                  ? 'Your RSVP has been received. We cannot wait to celebrate with you!'
                  : 'We will miss you! Your response has been recorded.'}
              </p>
              <button
                onClick={() => {
                  setStep('search')
                  setSelectedGuest(null)
                  setSearchQuery('')
                  setSearchResults([])
                  setRsvpStatus('attending')
                  setMealChoice('')
                  setDietary('')
                  setPlusOneRsvp('attending')
                  setPlusOneName('')
                  setPlusOneMeal('')
                }}
                className="text-xs underline underline-offset-2 transition-colors hover:opacity-70"
                style={{ color: accent }}
              >
                RSVP for another guest
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

function RegistrySection({ data, website, theme, accent, accentRgb }: {
  data: Record<string, unknown>
  website: WebsiteData
  theme: typeof THEME_CONFIG.classic
  accent: string
  accentRgb: string
}) {
  const links = (data.links as RegistryLink[]) || website.registry_links || []
  const filtered = links.filter(l => l.name && l.url)
  if (filtered.length === 0) return null

  return (
    <>
      <SectionHeading title="Registry" icon={Gift} accent={accent} headingFont={theme.headingFont} />
      <div className="flex flex-wrap justify-center gap-4">
        {filtered.map((link, i) => (
          <a
            key={i}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border-2 text-sm font-medium transition-all hover:shadow-md"
            style={{
              borderColor: accent,
              color: accent,
              backgroundColor: `rgba(${accentRgb}, 0.05)`,
            }}
          >
            <Gift className="w-4 h-4" />
            {link.name}
            <ExternalLink className="w-3 h-3 opacity-50" />
          </a>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

function FAQSection({ data, website, theme, accent }: {
  data: Record<string, unknown>
  website: WebsiteData
  theme: typeof THEME_CONFIG.classic
  accent: string
}) {
  const items = (data.items as FAQItem[]) || website.faq || []
  const filtered = items.filter(f => f.question && f.answer)
  if (filtered.length === 0) return null

  return (
    <>
      <SectionHeading title="FAQ" icon={HelpCircle} accent={accent} headingFont={theme.headingFont} />
      <div className="max-w-xl mx-auto space-y-0">
        {filtered.map((faq, i) => (
          <FAQAccordionItem key={i} faq={faq} theme={theme} accent={accent} defaultOpen={i === 0} />
        ))}
      </div>
    </>
  )
}

function FAQAccordionItem({ faq, theme, accent, defaultOpen }: {
  faq: FAQItem
  theme: typeof THEME_CONFIG.classic
  accent: string
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div style={{ borderBottom: `1px solid ${theme.borderColor}` }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-4 text-left"
      >
        <span className="text-sm font-medium pr-4" style={{ color: theme.textColor }}>
          {faq.question}
        </span>
        <ChevronDown
          className="w-4 h-4 shrink-0 transition-transform duration-200"
          style={{ color: accent, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>
      {open && (
        <div className="pb-4">
          <p className="text-sm leading-relaxed" style={{ color: theme.mutedColor }}>
            {faq.answer}
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// THINGS TO DO
// ---------------------------------------------------------------------------

function ThingsToDoSection({ data, website, theme, accent }: {
  data: Record<string, unknown>
  website: WebsiteData
  theme: typeof THEME_CONFIG.classic
  accent: string
}) {
  const items = (data.items as ThingsToDoItem[]) || website.things_to_do || []
  const filtered = items.filter(t => t.name)
  if (filtered.length === 0) return null

  return (
    <>
      <SectionHeading title="Things to Do" icon={MapPin} accent={accent} headingFont={theme.headingFont} />
      <div className="grid gap-4 sm:grid-cols-2">
        {filtered.map((item, i) => (
          <div
            key={i}
            className="p-4 rounded-lg border transition-colors"
            style={{ borderColor: theme.borderColor, backgroundColor: theme.sectionBg }}
          >
            <div className="flex items-start gap-3">
              <MapPin className="w-4 h-4 mt-0.5 shrink-0" style={{ color: accent }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" style={{ color: theme.textColor }}>{item.name}</p>
                {item.description && (
                  <p className="text-xs mt-1 leading-relaxed" style={{ color: theme.mutedColor }}>{item.description}</p>
                )}
                {item.category && (
                  <span
                    className="inline-block text-[10px] px-2 py-0.5 rounded mt-2"
                    style={{ backgroundColor: accent + '10', color: accent }}
                  >
                    {item.category}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// DRESS CODE
// ---------------------------------------------------------------------------

const DRESS_CODE_PRESETS: Record<string, { label: string; description: string }> = {
  black_tie: { label: 'Black Tie', description: 'Tuxedos and floor-length gowns' },
  black_tie_optional: { label: 'Black Tie Optional', description: 'Dark suits or tuxedos; formal dresses' },
  cocktail: { label: 'Cocktail', description: 'Cocktail dresses and suits or sport coats' },
  garden: { label: 'Garden Party', description: 'Flowy dresses and light-colored suits' },
  smart_casual: { label: 'Smart Casual', description: 'Dressy separates; no jeans or sneakers' },
  casual: { label: 'Casual', description: 'Come as you are! Comfort is key.' },
}

function DressCodeSection({ data, website, theme, accent }: {
  data: Record<string, unknown>
  website: WebsiteData
  theme: typeof THEME_CONFIG.classic
  accent: string
}) {
  const preset = data.preset as string
  const customText = (data.custom_text as string) || website.dress_code || ''

  const displayText = preset && preset !== 'custom' && DRESS_CODE_PRESETS[preset]
    ? DRESS_CODE_PRESETS[preset].description
    : customText

  if (!displayText) return null

  const label = preset && DRESS_CODE_PRESETS[preset]
    ? DRESS_CODE_PRESETS[preset].label
    : null

  return (
    <>
      <SectionHeading title="Dress Code" icon={Sparkles} accent={accent} headingFont={theme.headingFont} />
      <div className="text-center max-w-md mx-auto">
        {label && (
          <p
            className="text-lg font-medium mb-2"
            style={{ fontFamily: theme.headingFont, color: accent }}
          >
            {label}
          </p>
        )}
        <p className="text-sm leading-relaxed" style={{ color: theme.mutedColor }}>
          {displayText}
        </p>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// TRANSPORTATION
// ---------------------------------------------------------------------------

function TransportationSection({ data, theme, accent }: {
  data: Record<string, unknown>
  theme: typeof THEME_CONFIG.classic
  accent: string
}) {
  const details = data.details as string
  if (!details) return null

  return (
    <>
      <SectionHeading title="Transportation" icon={Car} accent={accent} headingFont={theme.headingFont} />
      <div className="max-w-xl mx-auto text-center">
        <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: theme.mutedColor }}>
          {details}
        </p>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// ACCOMMODATIONS / NEARBY STAYS
// ---------------------------------------------------------------------------

function AccommodationsSection({ data, accommodations, theme, accent, accentRgb }: {
  data: Record<string, unknown>
  accommodations: Accommodation[]
  theme: typeof THEME_CONFIG.classic
  accent: string
  accentRgb: string
}) {
  // Combine inline stays from section data with venue-level accommodations
  const inlineStays = (data.stays as Array<{ name: string; url: string; notes: string }>) || []
  const hasInline = inlineStays.some(s => s.name)
  const hasAccommodations = accommodations.length > 0

  if (!hasInline && !hasAccommodations) return null

  return (
    <>
      <SectionHeading title="Where to Stay" icon={Hotel} accent={accent} headingFont={theme.headingFont} />

      {/* Venue-level accommodations */}
      {hasAccommodations && (
        <div className="grid gap-4 sm:grid-cols-2 mb-6">
          {accommodations.map((acc) => (
            <div
              key={acc.id}
              className="p-5 rounded-lg border"
              style={{ borderColor: theme.borderColor, backgroundColor: theme.sectionBg }}
            >
              <h3 className="text-sm font-semibold mb-1" style={{ color: theme.textColor }}>{acc.name}</h3>
              {acc.distance_miles && (
                <p className="text-[10px] mb-2" style={{ color: theme.mutedColor }}>
                  {acc.distance_miles} miles away
                  {acc.price_range && ` | ${acc.price_range}`}
                </p>
              )}
              {acc.description && (
                <p className="text-xs leading-relaxed mb-2" style={{ color: theme.mutedColor }}>{acc.description}</p>
              )}
              {acc.block_code && (
                <div
                  className="text-xs px-3 py-2 rounded mt-2"
                  style={{ backgroundColor: accent + '10', color: accent }}
                >
                  Block code: <span className="font-mono font-semibold">{acc.block_code}</span>
                  {acc.block_deadline && (
                    <span className="block text-[10px] mt-0.5" style={{ color: theme.mutedColor }}>
                      Book by {formatDate(acc.block_deadline)}
                    </span>
                  )}
                </div>
              )}
              {acc.website_url && (
                <a
                  href={acc.website_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs mt-2 transition-opacity hover:opacity-70"
                  style={{ color: accent }}
                >
                  Visit Website <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Inline stays from section data */}
      {hasInline && (
        <div className="space-y-3">
          {inlineStays.filter(s => s.name).map((stay, i) => (
            <div key={i} className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${theme.borderColor}` }}>
              <span className="text-sm" style={{ color: theme.textColor }}>{stay.name}</span>
              {stay.url && (
                <a
                  href={stay.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs flex items-center gap-1 transition-opacity hover:opacity-70"
                  style={{ color: accent }}
                >
                  View <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
