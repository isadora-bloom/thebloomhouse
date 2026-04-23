'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export interface CoupleContext {
  slug: string         // URL slug (venue identifier)
  venueId: string | null
  weddingId: string | null
  /**
   * Per-venue AI assistant name from venue_ai_config.ai_name. Falls back to
   * 'Sage' so UI that reads this is never undefined. Every user-visible
   * "Ask Sage" / "Chat with Sage" string in the couple portal must read
   * from here so white-label venues (Oakwood: "Ivy", etc.) render correctly.
   */
  aiName: string
  /**
   * Venue's display name from venue_config.business_name, falling back to
   * venues.name. Consumed by couple-facing headers. Never undefined —
   * defaults to an empty string when the venue lookup hasn't resolved yet.
   */
  venueName: string
  loading: boolean
  isDemo: boolean
}

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'
const DEMO_WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const DEMO_SLUG = 'hawthorne-manor'
const DEFAULT_AI_NAME = 'Sage'

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
  const [aiName, setAiName] = useState<string>(DEFAULT_AI_NAME)
  const [venueName, setVenueName] = useState<string>('')
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
        .select('id, name')
        .eq('slug', slug)
        .maybeSingle()

      if (!venue) {
        setLoading(false)
        return
      }
      setVenueId(venue.id)
      // Start with the short name from venues; venue_config.business_name
      // may override below for a more polished display label.
      if (venue.name) setVenueName(venue.name as string)

      // Resolve the per-venue AI assistant name + business_name display
      // in a single batched read. Never block on either — fall through to
      // defaults if the rows are missing.
      const [{ data: aiConfig }, { data: cfg }] = await Promise.all([
        supabase.from('venue_ai_config').select('ai_name').eq('venue_id', venue.id).maybeSingle(),
        supabase.from('venue_config').select('business_name').eq('venue_id', venue.id).maybeSingle(),
      ])
      const resolvedAiName = (aiConfig?.ai_name as string | null)?.trim()
      if (resolvedAiName) setAiName(resolvedAiName)
      const resolvedBusinessName = (cfg?.business_name as string | null)?.trim()
      if (resolvedBusinessName) setVenueName(resolvedBusinessName)

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

  return { slug, venueId, weddingId, aiName, venueName, loading, isDemo }
}
