'use client'

/**
 * Couple Portal → Venue Info (read-only)
 *
 * Tier-B audit #55. Couples need a single page that answers "what's
 * the address?" and (when populated) "where do I park?" / "where do
 * I enter?" / "who do I call on the day?" Surfaced as its own page
 * so guests, vendors, and the couple themselves can pull the URL
 * up on a phone instead of digging through email.
 *
 * Today this page surfaces the venue address fields that already
 * exist (migration 008: address_line1, city, state, zip, latitude,
 * longitude). Schema additions for parking_instructions /
 * entry_instructions / day_of_contact land in #52 — this page
 * already accommodates them via optional render blocks so the
 * follow-up is purely additive.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { MapPin, ExternalLink, Phone } from 'lucide-react'

interface VenueLocation {
  address_line1: string | null
  city: string | null
  state: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
  // These fields don't exist on `venues` yet — read as undefined and
  // gate rendering accordingly. When migration 052 lands they'll
  // populate without code changes here.
  parking_instructions?: string | null
  entry_instructions?: string | null
  day_of_contact_name?: string | null
  day_of_contact_phone?: string | null
}

function formatAddress(v: VenueLocation): string | null {
  if (!v.address_line1 && !v.city) return null
  const cityState = [v.city, v.state].filter(Boolean).join(', ')
  const tail = [cityState, v.zip].filter(Boolean).join(' ')
  return [v.address_line1, tail].filter(Boolean).join(', ')
}

function googleMapsHref(v: VenueLocation): string | null {
  if (v.latitude !== null && v.longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${v.latitude},${v.longitude}`
  }
  const address = formatAddress(v)
  if (!address) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
}

export default function VenueInfoPage() {
  const { venueId, venueName } = useCoupleContext()
  const [location, setLocation] = useState<VenueLocation | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    async function load() {
      const { data } = await supabase
        .from('venues')
        .select('address_line1, city, state, zip, latitude, longitude')
        .eq('id', venueId)
        .maybeSingle()
      setLocation((data as VenueLocation | null) ?? null)
      setLoading(false)
    }
    load()
  }, [venueId])

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="text-sm text-stone-500">Loading…</div>
      </div>
    )
  }

  const address = location ? formatAddress(location) : null
  const mapsHref = location ? googleMapsHref(location) : null

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <header className="mb-8">
        <h1
          className="text-3xl mb-2"
          style={{ fontFamily: 'var(--couple-font-heading)' }}
        >
          Venue Info
        </h1>
        <p className="text-stone-600 leading-relaxed">
          Everything you and your guests need to find {venueName} and get
          to where you&apos;re going on the day.
        </p>
      </header>

      {address ? (
        <section className="mb-8 rounded-2xl border border-stone-200 bg-white p-6">
          <div className="flex items-start gap-3 mb-4">
            <MapPin className="w-5 h-5 text-stone-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="font-medium text-stone-900 mb-1">Address</h2>
              <p className="text-stone-700 leading-relaxed">{address}</p>
            </div>
          </div>
          {mapsHref && (
            <a
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-stone-700 hover:text-stone-900 underline underline-offset-2"
            >
              Open in Google Maps
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </section>
      ) : (
        <section className="mb-8 rounded-2xl border border-dashed border-stone-300 bg-white p-6">
          <p className="text-sm text-stone-500">
            Your venue&apos;s address hasn&apos;t been added yet. Check back
            soon, or reach out to your coordinator if you need it sooner.
          </p>
        </section>
      )}

      {/* Future blocks — populate when #52 schema lands */}
      {location?.parking_instructions && (
        <section className="mb-8 rounded-2xl border border-stone-200 bg-white p-6">
          <h2 className="font-medium text-stone-900 mb-2">Parking</h2>
          <p className="text-stone-700 whitespace-pre-line leading-relaxed">
            {location.parking_instructions}
          </p>
        </section>
      )}

      {location?.entry_instructions && (
        <section className="mb-8 rounded-2xl border border-stone-200 bg-white p-6">
          <h2 className="font-medium text-stone-900 mb-2">Where to enter</h2>
          <p className="text-stone-700 whitespace-pre-line leading-relaxed">
            {location.entry_instructions}
          </p>
        </section>
      )}

      {(location?.day_of_contact_name || location?.day_of_contact_phone) && (
        <section className="mb-8 rounded-2xl border border-stone-200 bg-white p-6">
          <div className="flex items-start gap-3">
            <Phone className="w-5 h-5 text-stone-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="font-medium text-stone-900 mb-1">
                Day-of contact
              </h2>
              {location.day_of_contact_name && (
                <p className="text-stone-700">{location.day_of_contact_name}</p>
              )}
              {location.day_of_contact_phone && (
                <a
                  href={`tel:${location.day_of_contact_phone}`}
                  className="text-stone-700 underline underline-offset-2"
                >
                  {location.day_of_contact_phone}
                </a>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
