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

export function useCoupleContext(): CoupleContext {
  const params = useParams<{ slug?: string }>()
  const slug = params?.slug || DEMO_SLUG

  const [venueId, setVenueId] = useState<string | null>(null)
  const [weddingId, setWeddingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isDemo, setIsDemo] = useState(false)

  useEffect(() => {
    async function resolve() {
      // Check demo mode first
      const demo = typeof document !== 'undefined' &&
        document.cookie.split('; ').some((c) => c === 'bloom_demo=true')

      if (demo) {
        setIsDemo(true)
        setVenueId(DEMO_VENUE_ID)
        setWeddingId(DEMO_WEDDING_ID)
        setLoading(false)
        return
      }

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
  }, [slug])

  return { slug, venueId, weddingId, loading, isDemo }
}
