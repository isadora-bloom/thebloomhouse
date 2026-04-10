'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export interface CoupleContext {
  slug: string         // URL slug (venue identifier)
  venueId: string | null
  weddingId: string | null
  loading: boolean
  isDemo: boolean
}

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'
const DEMO_WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const DEMO_SLUG = 'hawthorne-manor'

/**
 * Synchronously detect demo mode from the document cookie.
 * Used as the initial state so the very first render already has IDs
 * (queries don't fire with null wedding_id on first paint).
 */
function detectDemoSync(): boolean {
  if (typeof document === 'undefined') return false
  return document.cookie.split('; ').some((c) => c === 'bloom_demo=true')
}

export function useCoupleContext(): CoupleContext {
  const params = useParams<{ slug?: string }>()
  const slug = params?.slug || DEMO_SLUG

  // Initialize state synchronously for demo mode so the first render
  // already has the right IDs — no flash of wedding_id=null queries.
  const initialDemo = detectDemoSync()
  const [venueId, setVenueId] = useState<string | null>(initialDemo ? DEMO_VENUE_ID : null)
  const [weddingId, setWeddingId] = useState<string | null>(initialDemo ? DEMO_WEDDING_ID : null)
  const [loading, setLoading] = useState(!initialDemo)
  const [isDemo, setIsDemo] = useState(initialDemo)

  useEffect(() => {
    // If we already resolved synchronously (demo mode), skip the async path.
    if (initialDemo) return

    async function resolve() {
      const supabase = createClient()

      // Resolve venue from slug
      const { data: venue } = await supabase
        .from('venues')
        .select('id')
        .eq('slug', slug)
        .maybeSingle()

      if (!venue) {
        setLoading(false)
        return
      }
      setVenueId(venue.id)

      // Resolve wedding from authenticated couple user
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        // Try to find a wedding linked to this user via people table
        const { data: person } = await supabase
          .from('people')
          .select('wedding_id')
          .eq('email', user.email!)
          .in('role', ['partner1', 'partner2'])
          .eq('venue_id', venue.id)
          .maybeSingle()

        if (person?.wedding_id) {
          setWeddingId(person.wedding_id as string)
        }
      }

      setLoading(false)
    }

    resolve()
  }, [slug, initialDemo])

  // Mark isDemo on second render in case detection runs before document is ready
  useEffect(() => {
    const demo = detectDemoSync()
    if (demo && !isDemo) {
      setIsDemo(true)
      if (!venueId) setVenueId(DEMO_VENUE_ID)
      if (!weddingId) setWeddingId(DEMO_WEDDING_ID)
      setLoading(false)
    }
  }, [isDemo, venueId, weddingId])

  return { slug, venueId, weddingId, loading, isDemo }
}
