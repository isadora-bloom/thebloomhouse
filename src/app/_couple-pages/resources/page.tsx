'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  BookOpen,
  Link as LinkIcon,
  BookMarked,
  Camera,
  Calendar,
  Map,
  Phone,
  Mail,
  Globe,
  FileText,
  Star,
  Heart,
  Home,
  Users,
  ExternalLink,
  Sparkles,
  Music,
  Utensils,
  MapPin,
  ShoppingBag,
  MessageCircle,
  Loader2,
  Clock,
  Info,
} from 'lucide-react'
import { useRouter } from 'next/navigation'

// TODO: Get from auth session
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VenueResource {
  id: string
  venue_id: string
  title: string
  subtitle: string | null
  url: string
  icon: string
  is_external: boolean
  sort_order: number
  is_active: boolean
}

// ---------------------------------------------------------------------------
// Icon Mapping
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ElementType> = {
  link: LinkIcon,
  book: BookMarked,
  camera: Camera,
  calendar: Calendar,
  map: Map,
  phone: Phone,
  mail: Mail,
  globe: Globe,
  file: FileText,
  star: Star,
  heart: Heart,
  home: Home,
  users: Users,
  sparkles: Sparkles,
  music: Music,
  utensils: Utensils,
  'map-pin': MapPin,
  shopping: ShoppingBag,
  message: MessageCircle,
  clock: Clock,
  info: Info,
  'external-link': ExternalLink,
  'book-open': BookOpen,
}

function getIcon(iconName: string): React.ElementType {
  return ICON_MAP[iconName] || LinkIcon
}

// ---------------------------------------------------------------------------
// Default Resources (fallback when none configured)
// ---------------------------------------------------------------------------

function getDefaultResources(slug: string): VenueResource[] {
  return [
    {
      id: 'default-vendors',
      venue_id: VENUE_ID,
      title: 'Vendor Directory',
      subtitle: 'Browse preferred vendors for your wedding',
      url: `/couple/${slug}/vendors`,
      icon: 'users',
      is_external: false,
      sort_order: 0,
      is_active: true,
    },
    {
      id: 'default-stays',
      venue_id: VENUE_ID,
      title: 'Accommodations',
      subtitle: 'Nearby lodging for you and your guests',
      url: `/couple/${slug}/stays`,
      icon: 'home',
      is_external: false,
      sort_order: 1,
      is_active: true,
    },
    {
      id: 'default-chat',
      venue_id: VENUE_ID,
      title: 'Chat with Sage',
      subtitle: 'Your AI wedding concierge is here to help',
      url: `/couple/${slug}/chat`,
      icon: 'sparkles',
      is_external: false,
      sort_order: 2,
      is_active: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// Resource Card
// ---------------------------------------------------------------------------

function ResourceCard({
  resource,
  onClick,
}: {
  resource: VenueResource
  onClick: () => void
}) {
  const Icon = getIcon(resource.icon)

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left bg-white rounded-xl border border-gray-100 p-6',
        'shadow-sm hover:shadow-md transition-all duration-200',
        'group cursor-pointer',
        'hover:border-gray-200'
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--couple-primary) 10%, transparent)',
          }}
        >
          <Icon
            className="w-5 h-5"
            style={{ color: 'var(--couple-primary)' }}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-gray-900 group-hover:text-gray-700 truncate">
              {resource.title}
            </h3>
            {resource.is_external && (
              <ExternalLink className="w-3.5 h-3.5 text-gray-300 shrink-0 group-hover:text-gray-400 transition-colors" />
            )}
          </div>
          {resource.subtitle && (
            <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">
              {resource.subtitle}
            </p>
          )}
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Resources Page
// ---------------------------------------------------------------------------

export default function ResourcesPage() {
  const [resources, setResources] = useState<VenueResource[]>([])
  const [loading, setLoading] = useState(true)
  const [usingDefaults, setUsingDefaults] = useState(false)
  const router = useRouter()

  // Derive slug from URL
  const getSlug = useCallback(() => {
    if (typeof window === 'undefined') return 'rixey-manor'
    const parts = window.location.pathname.split('/')
    // URL: /couple/{slug}/resources
    const coupleIdx = parts.indexOf('couple')
    if (coupleIdx !== -1 && parts[coupleIdx + 1]) {
      return parts[coupleIdx + 1]
    }
    return 'rixey-manor'
  }, [])

  // ---- Load resources on mount ----
  useEffect(() => {
    async function loadResources() {
      try {
        const supabase = createClient()

        const { data, error } = await supabase
          .from('venue_resources')
          .select('*')
          .eq('venue_id', VENUE_ID)
          .eq('is_active', true)
          .order('sort_order', { ascending: true })

        if (error) {
          console.error('Failed to load resources:', error)
        }

        if (data && data.length > 0) {
          setResources(data as VenueResource[])
          setUsingDefaults(false)
        } else {
          // Use defaults
          const slug = getSlug()
          setResources(getDefaultResources(slug))
          setUsingDefaults(true)
        }
      } catch (err) {
        console.error('Failed to load resources:', err)
        const slug = getSlug()
        setResources(getDefaultResources(slug))
        setUsingDefaults(true)
      } finally {
        setLoading(false)
      }
    }

    loadResources()
  }, [getSlug])

  // ---- Handle click ----
  function handleResourceClick(resource: VenueResource) {
    if (resource.is_external) {
      window.open(resource.url, '_blank', 'noopener,noreferrer')
    } else {
      router.push(resource.url)
    }
  }

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

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <BookOpen className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1
            className="text-xl font-semibold"
            style={{
              fontFamily: 'var(--couple-font-heading)',
              color: 'var(--couple-primary)',
            }}
          >
            Resources
          </h1>
          <p className="text-sm text-gray-500">
            Helpful links and tools for your planning
          </p>
        </div>
      </div>

      {/* ---- Resource Grid ---- */}
      {resources.length === 0 ? (
        /* ---- Empty State ---- */
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center max-w-md mx-auto">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--couple-primary) 10%, transparent)',
            }}
          >
            <BookOpen
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
            No resources yet
          </h3>
          <p className="text-sm text-gray-500">
            Your venue has not added any resources yet. Check back soon!
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {resources.map((resource) => (
            <ResourceCard
              key={resource.id}
              resource={resource}
              onClick={() => handleResourceClick(resource)}
            />
          ))}
        </div>
      )}

      {/* ---- Defaults hint ---- */}
      {usingDefaults && (
        <p className="text-xs text-gray-400 text-center pt-2">
          Showing default resources. Your venue can customize this list.
        </p>
      )}
    </div>
  )
}
