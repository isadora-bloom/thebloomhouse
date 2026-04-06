'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  CalendarPlus,
  Clock,
  Video,
  Phone,
  Building2,
  ClipboardList,
  Package,
  Users,
  PartyPopper,
  X,
  Loader2,
  ExternalLink,
  Mail,
} from 'lucide-react'

// TODO: Get from auth session
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MeetingType {
  id: string
  slug: string
  name: string
  duration: string
  description: string
  icon: React.ElementType
  category: 'getting-started' | 'planning' | 'pre-wedding'
}

interface VenueConfig {
  calendly_link: string | null
  coordinator_email: string | null
  coordinator_phone: string | null
  business_name: string | null
}

// ---------------------------------------------------------------------------
// Meeting Types Configuration
// ---------------------------------------------------------------------------

const MEETING_TYPES: MeetingType[] = [
  // Getting Started
  {
    id: 'onboarding',
    slug: 'onboarding-initial-planning',
    name: 'Onboarding & Initial Planning',
    duration: '60 min',
    description:
      'Kick off your wedding planning journey! We will walk through the venue, discuss your vision, and set up your planning timeline.',
    icon: PartyPopper,
    category: 'getting-started',
  },
  {
    id: 'quick-call',
    slug: 'quick-phone-call',
    name: 'Quick Phone Call',
    duration: '15 min',
    description:
      'Have a quick question? Book a short call with your coordinator for fast answers.',
    icon: Phone,
    category: 'getting-started',
  },

  // Planning Meetings
  {
    id: 'video-meeting',
    slug: 'planning-meeting-video',
    name: 'Planning Meeting - Video',
    duration: '60 min',
    description:
      'A virtual planning session to work through details, review progress, and make decisions together.',
    icon: Video,
    category: 'planning',
  },
  {
    id: 'in-person',
    slug: 'planning-meeting-in-person',
    name: 'Planning Meeting - In Person',
    duration: '60 min',
    description:
      'Meet at the venue in person to walk through spaces, finalize layouts, and discuss logistics.',
    icon: Building2,
    category: 'planning',
  },

  // Pre-Wedding
  {
    id: 'final-walkthrough',
    slug: 'final-walkthrough',
    name: 'Final Walkthrough',
    duration: 'Varies',
    description:
      'The final run-through at the venue before your wedding day. We will confirm every detail together.',
    icon: ClipboardList,
    category: 'pre-wedding',
  },
  {
    id: 'drop-off',
    slug: 'pre-wedding-drop-off',
    name: 'Pre-Wedding Drop Off',
    duration: 'Varies',
    description:
      'Bring your decor, personal items, and anything else to the venue ahead of the big day.',
    icon: Package,
    category: 'pre-wedding',
  },
  {
    id: 'vendor-walkthrough',
    slug: 'vendor-walkthrough',
    name: 'Vendor Walkthrough',
    duration: 'Varies',
    description:
      'Bring your vendors to the venue to coordinate setups, timelines, and logistics.',
    icon: Users,
    category: 'pre-wedding',
  },
]

const CATEGORY_LABELS: Record<string, string> = {
  'getting-started': 'Getting Started',
  planning: 'Planning Meetings',
  'pre-wedding': 'Pre-Wedding',
}

const CATEGORY_ORDER = ['getting-started', 'planning', 'pre-wedding']

// ---------------------------------------------------------------------------
// Meeting Card
// ---------------------------------------------------------------------------

function MeetingCard({
  meeting,
  onSelect,
}: {
  meeting: MeetingType
  onSelect: (meeting: MeetingType) => void
}) {
  const Icon = meeting.icon

  return (
    <button
      onClick={() => onSelect(meeting)}
      className={cn(
        'w-full text-left bg-white rounded-xl border border-gray-100 p-5',
        'shadow-sm hover:shadow-md hover:border-gray-200 transition-all duration-200',
        'group cursor-pointer'
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 transition-colors"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, transparent)',
          }}
        >
          <Icon
            className="w-5 h-5 transition-colors"
            style={{ color: 'var(--couple-primary)' }}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="font-medium text-gray-900 group-hover:text-gray-700 truncate">
              {meeting.name}
            </h3>
            <div className="flex items-center gap-1 shrink-0 text-xs text-gray-400">
              <Clock className="w-3 h-3" />
              {meeting.duration}
            </div>
          </div>
          <p className="text-sm text-gray-500 line-clamp-2">
            {meeting.description}
          </p>
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Calendly Modal
// ---------------------------------------------------------------------------

function CalendlyModal({
  meeting,
  calendlyLink,
  onClose,
}: {
  meeting: MeetingType
  calendlyLink: string
  onClose: () => void
}) {
  const [iframeLoaded, setIframeLoaded] = useState(false)

  // Build the Calendly embed URL
  const hostname =
    typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const embedUrl = `${calendlyLink}/${meeting.slug}?embed_domain=${hostname}&embed_type=Inline`

  // Close on escape key
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-3xl h-[85vh] mx-4 bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--couple-primary) 10%, transparent)',
              }}
            >
              <meeting.icon
                className="w-4 h-4"
                style={{ color: 'var(--couple-primary)' }}
              />
            </div>
            <div>
              <h3
                className="font-semibold text-gray-900"
                style={{ fontFamily: 'var(--couple-font-heading)' }}
              >
                {meeting.name}
              </h3>
              <p className="text-xs text-gray-500">{meeting.duration}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Calendly iframe */}
        <div className="flex-1 relative">
          {!iframeLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-white">
              <div className="text-center">
                <Loader2
                  className="w-8 h-8 animate-spin mx-auto mb-3"
                  style={{ color: 'var(--couple-primary)' }}
                />
                <p className="text-sm text-gray-500">
                  Loading available times...
                </p>
              </div>
            </div>
          )}
          <iframe
            src={embedUrl}
            title={`Book ${meeting.name}`}
            className="w-full h-full border-0"
            onLoad={() => setIframeLoaded(true)}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fallback — No Calendly Configured
// ---------------------------------------------------------------------------

function NoCalendlyFallback({ config }: { config: VenueConfig | null }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center max-w-md mx-auto mt-8">
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--couple-primary) 10%, transparent)',
        }}
      >
        <CalendarPlus
          className="w-7 h-7"
          style={{ color: 'var(--couple-primary)' }}
        />
      </div>
      <h3
        className="text-lg font-semibold mb-2"
        style={{
          fontFamily: 'var(--couple-font-heading)',
          color: 'var(--couple-primary)',
        }}
      >
        Contact Your Coordinator
      </h3>
      <p className="text-sm text-gray-500 mb-6">
        Online booking is not set up yet. Reach out to your coordinator to
        schedule a meeting.
      </p>

      {config?.coordinator_email && (
        <a
          href={`mailto:${config.coordinator_email}`}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-white text-sm font-medium transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Mail className="w-4 h-4" />
          Email {config.business_name || 'Your Coordinator'}
        </a>
      )}

      {config?.coordinator_phone && (
        <p className="mt-3 text-sm text-gray-500">
          Or call:{' '}
          <a
            href={`tel:${config.coordinator_phone}`}
            className="font-medium underline"
            style={{ color: 'var(--couple-primary)' }}
          >
            {config.coordinator_phone}
          </a>
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booking Page
// ---------------------------------------------------------------------------

export default function BookingPage() {
  const [venueConfig, setVenueConfig] = useState<VenueConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingType | null>(
    null
  )

  // ---- Load venue config on mount ----
  useEffect(() => {
    async function loadConfig() {
      try {
        const supabase = createClient()

        const { data, error } = await supabase
          .from('venue_config')
          .select(
            'calendly_link, coordinator_email, coordinator_phone, business_name'
          )
          .eq('venue_id', VENUE_ID)
          .single()

        if (error) {
          console.error('Failed to load venue config:', error)
        }

        setVenueConfig(data as VenueConfig | null)
      } catch (err) {
        console.error('Failed to load venue config:', err)
      } finally {
        setLoading(false)
      }
    }

    loadConfig()
  }, [])

  // Group meeting types by category
  const groupedMeetings = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    meetings: MEETING_TYPES.filter((m) => m.category === cat),
  }))

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2
          className="w-8 h-8 animate-spin"
          style={{ color: 'var(--couple-primary)' }}
        />
      </div>
    )
  }

  const calendlyLink = venueConfig?.calendly_link

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <CalendarPlus className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1
            className="text-xl font-semibold"
            style={{
              fontFamily: 'var(--couple-font-heading)',
              color: 'var(--couple-primary)',
            }}
          >
            Book a Meeting
          </h1>
          <p className="text-sm text-gray-500">
            Schedule time with your planning team
          </p>
        </div>
      </div>

      {/* ---- Main Content ---- */}
      {!calendlyLink ? (
        <NoCalendlyFallback config={venueConfig} />
      ) : (
        <div className="space-y-8">
          {groupedMeetings.map((group) => (
            <div key={group.category}>
              {/* Category Header */}
              <h2
                className="text-sm font-semibold uppercase tracking-wider mb-4"
                style={{ color: 'var(--couple-primary)' }}
              >
                {group.label}
              </h2>

              {/* Meeting Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {group.meetings.map((meeting) => (
                  <MeetingCard
                    key={meeting.id}
                    meeting={meeting}
                    onSelect={setSelectedMeeting}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Direct Link */}
          <div className="text-center pt-4 border-t border-gray-100">
            <a
              href={calendlyLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              View all available times
            </a>
          </div>
        </div>
      )}

      {/* ---- Calendly Modal ---- */}
      {selectedMeeting && calendlyLink && (
        <CalendlyModal
          meeting={selectedMeeting}
          calendlyLink={calendlyLink}
          onClose={() => setSelectedMeeting(null)}
        />
      )}
    </div>
  )
}
