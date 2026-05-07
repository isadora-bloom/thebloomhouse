'use client'

/**
 * Couple Portal → Day-of view (Tier-B #59A)
 *
 * Mobile-first single page surfacing the things a couple needs to grab
 * on the day itself, when they're at the venue with a phone in hand:
 *
 *   - Today's timeline (or wedding-date timeline) in big legible type
 *   - Day-of contact: tap-to-call phone (mig 221 day_of_contact_phone)
 *   - Venue address + tap to open in Maps (mig 008 + 221 lat/lng)
 *   - Parking + entry instructions (mig 221) when populated
 *   - Top 3 incomplete checklist items
 *
 * Visibility:
 *   - Always reachable via direct URL
 *   - Sidebar only surfaces this when wedding_date - today <= 3
 *     (gated in couple-sidebar.tsx via useCoupleContext.weddingDate)
 *   - When a couple lands here >7 days out, render an "available 3 days
 *     before your wedding" placeholder so the page isn't useless to
 *     someone who clicked too early.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { MapPin, Phone, ExternalLink, Calendar, CheckSquare, Clock } from 'lucide-react'

interface VenueLogistics {
  address_line1: string | null
  city: string | null
  state: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
  parking_instructions: string | null
  entry_instructions: string | null
  day_of_contact_name: string | null
  day_of_contact_phone: string | null
}

interface TimelineRow {
  id: string
  title: string
  time: string | null
  category: string | null
}

interface ChecklistRow {
  id: string
  title: string
  due_date: string | null
}

function formatAddress(v: VenueLogistics): string | null {
  if (!v.address_line1 && !v.city) return null
  const cityState = [v.city, v.state].filter(Boolean).join(', ')
  const tail = [cityState, v.zip].filter(Boolean).join(' ')
  return [v.address_line1, tail].filter(Boolean).join(', ')
}

function googleMapsHref(v: VenueLogistics): string | null {
  if (v.latitude !== null && v.longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${v.latitude},${v.longitude}`
  }
  const a = formatAddress(v)
  if (!a) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`
}

function formatTime(t: string | null): string {
  if (!t) return ''
  // Timeline times stored as HH:MM:SS or HH:MM. Display 12-hour.
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (!m) return t
  const h24 = parseInt(m[1], 10)
  const mins = m[2]
  const ampm = h24 >= 12 ? 'pm' : 'am'
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24
  return `${h12}:${mins} ${ampm}`
}

export default function DayOfPage() {
  const { venueId, weddingId, weddingDate, slug } = useCoupleContext()
  const [logistics, setLogistics] = useState<VenueLogistics | null>(null)
  const [timeline, setTimeline] = useState<TimelineRow[]>([])
  const [checklist, setChecklist] = useState<ChecklistRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!venueId || !weddingId) return
    const supabase = createClient()
    let cancelled = false
    async function load() {
      const [venueRes, timelineRes, checklistRes] = await Promise.all([
        supabase
          .from('venues')
          .select(
            'address_line1, city, state, zip, latitude, longitude, parking_instructions, entry_instructions, day_of_contact_name, day_of_contact_phone',
          )
          .eq('id', venueId)
          .maybeSingle(),
        supabase
          .from('timeline')
          .select('id, title, time, category')
          .eq('wedding_id', weddingId)
          .order('time', { ascending: true }),
        supabase
          .from('checklist_items')
          .select('id, title, due_date')
          .eq('wedding_id', weddingId)
          .eq('is_completed', false)
          .order('due_date', { ascending: true, nullsFirst: false })
          .limit(3),
      ])
      if (cancelled) return
      setLogistics((venueRes.data as VenueLogistics | null) ?? null)
      setTimeline((timelineRes.data as TimelineRow[] | null) ?? [])
      setChecklist((checklistRes.data as ChecklistRow[] | null) ?? [])
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [venueId, weddingId])

  // Visibility gate: friendly placeholder when too early.
  const daysOut = weddingDate
    ? Math.ceil(
        (new Date(weddingDate + 'T00:00:00').getTime() -
          new Date(new Date().toLocaleDateString('en-CA') + 'T00:00:00').getTime()) /
          (1000 * 60 * 60 * 24),
      )
    : null

  if (daysOut !== null && daysOut > 7) {
    return (
      <div className="max-w-md mx-auto px-6 py-16 text-center">
        <div
          className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center"
          style={{ backgroundColor: '#7D847115' }}
        >
          <Calendar className="w-8 h-8" style={{ color: 'var(--couple-primary)' }} />
        </div>
        <h1
          className="text-3xl mb-3"
          style={{ fontFamily: 'var(--couple-font-heading)' }}
        >
          You&apos;re {daysOut} days out
        </h1>
        <p className="text-stone-600 leading-relaxed mb-6">
          This page is here for the day itself: the timeline, where to
          enter, who to call. We&apos;ll surface it in your sidebar a
          few days before your wedding.
        </p>
        <Link
          href={`/couple/${slug}`}
          className="text-sm text-stone-700 underline underline-offset-4"
        >
          Back to your dashboard
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12 text-stone-500">Loading…</div>
    )
  }

  const address = logistics ? formatAddress(logistics) : null
  const mapsHref = logistics ? googleMapsHref(logistics) : null

  return (
    <div className="max-w-2xl mx-auto px-5 py-8">
      <header className="mb-8">
        <h1
          className="text-3xl sm:text-4xl mb-2"
          style={{ fontFamily: 'var(--couple-font-heading)' }}
        >
          Day-of
        </h1>
        <p className="text-stone-600">
          Everything you need today, in one place.
        </p>
      </header>

      {/* Day-of contact — biggest, most-tappable element */}
      {logistics?.day_of_contact_phone && (
        <a
          href={`tel:${logistics.day_of_contact_phone}`}
          className="block bg-white rounded-2xl p-6 mb-4 border border-stone-200 active:bg-stone-50"
        >
          <div className="flex items-center gap-4">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Phone className="w-7 h-7 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-stone-500 mb-1">Tap to call</p>
              <p className="text-lg font-medium text-stone-900 truncate">
                {logistics.day_of_contact_name ?? 'Day-of contact'}
              </p>
              <p className="text-base text-stone-700">
                {logistics.day_of_contact_phone}
              </p>
            </div>
          </div>
        </a>
      )}

      {/* Address + Maps link */}
      {address && (
        <a
          href={mapsHref ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="block bg-white rounded-2xl p-6 mb-4 border border-stone-200 active:bg-stone-50"
        >
          <div className="flex items-start gap-4">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: '#7D847115' }}
            >
              <MapPin
                className="w-7 h-7"
                style={{ color: 'var(--couple-primary)' }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-stone-500 mb-1">Open in Maps</p>
              <p className="text-base text-stone-900 leading-snug">{address}</p>
              <span className="inline-flex items-center gap-1 text-xs text-stone-500 mt-2">
                Google Maps <ExternalLink className="w-3 h-3" />
              </span>
            </div>
          </div>
        </a>
      )}

      {/* Where to enter / parking — only render when populated */}
      {logistics?.entry_instructions && (
        <section className="bg-white rounded-2xl p-5 mb-4 border border-stone-200">
          <h2 className="text-base font-medium text-stone-900 mb-2">
            Where to enter
          </h2>
          <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-line">
            {logistics.entry_instructions}
          </p>
        </section>
      )}

      {logistics?.parking_instructions && (
        <section className="bg-white rounded-2xl p-5 mb-4 border border-stone-200">
          <h2 className="text-base font-medium text-stone-900 mb-2">Parking</h2>
          <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-line">
            {logistics.parking_instructions}
          </p>
        </section>
      )}

      {/* Timeline */}
      {timeline.length > 0 && (
        <section className="bg-white rounded-2xl p-5 mb-4 border border-stone-200">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <h2 className="text-base font-medium text-stone-900">Today&apos;s flow</h2>
          </div>
          <div className="space-y-3">
            {timeline.map((t) => (
              <div key={t.id} className="flex items-start gap-3">
                <p
                  className="text-base tabular-nums shrink-0 w-20"
                  style={{ color: 'var(--couple-primary)' }}
                >
                  {formatTime(t.time)}
                </p>
                <p className="text-base text-stone-800 flex-1">{t.title}</p>
              </div>
            ))}
          </div>
          <Link
            href={`/couple/${slug}/timeline`}
            className="mt-4 inline-flex items-center gap-1 text-sm text-stone-600 underline underline-offset-4"
          >
            See full timeline
          </Link>
        </section>
      )}

      {/* Top 3 incomplete checklist items — small surface, tap to mark complete */}
      {checklist.length > 0 && (
        <section className="bg-white rounded-2xl p-5 mb-4 border border-stone-200">
          <div className="flex items-center gap-2 mb-3">
            <CheckSquare
              className="w-4 h-4"
              style={{ color: 'var(--couple-primary)' }}
            />
            <h2 className="text-base font-medium text-stone-900">
              Still on your list
            </h2>
          </div>
          <ul className="space-y-2">
            {checklist.map((c) => (
              <li
                key={c.id}
                className="text-sm text-stone-800 leading-snug border-b border-stone-100 last:border-0 pb-2 last:pb-0"
              >
                {c.title}
                {c.due_date && (
                  <span className="ml-2 text-xs text-stone-400">
                    {new Date(c.due_date + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <Link
            href={`/couple/${slug}/checklist`}
            className="mt-3 inline-flex items-center gap-1 text-sm text-stone-600 underline underline-offset-4"
          >
            Open full checklist
          </Link>
        </section>
      )}

      <div className="text-center mt-8">
        <Link
          href={`/couple/${slug}`}
          className="text-sm text-stone-500 underline underline-offset-4"
        >
          Back to your dashboard
        </Link>
      </div>
    </div>
  )
}
