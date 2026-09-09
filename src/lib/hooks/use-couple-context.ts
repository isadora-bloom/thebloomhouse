'use client'

import { createContext, createElement, useContext, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export interface CoupleContext {
  slug: string         // URL slug (venue identifier)
  venueId: string | null
  weddingId: string | null
  /**
   * Per-venue AI assistant name from venue_ai_config.ai_name. Every
   * user-visible "Ask ..." / "Chat with ..." string in the couple portal
   * must read from here so white-label venues (Oakwood: "Ivy", etc.)
   * render correctly.
   *
   * The fallback is deliberately generic. It used to be 'Sage', which is
   * Bloom's own house name, so for one paint of every page a venue's
   * couples were greeted by another company's assistant. A venue that has
   * named theirs gets the real name on the first render, seeded from the
   * server layout through CoupleAiNameProvider.
   */
  aiName: string
  /**
   * Venue's display name from venue_config.business_name, falling back to
   * venues.name. Consumed by couple-facing headers. Never undefined —
   * defaults to an empty string when the venue lookup hasn't resolved yet.
   */
  venueName: string
  /**
   * Wedding date as ISO date string (YYYY-MM-DD) or null if not yet
   * set. Surfaced so visibility-gated UI (e.g. day-of print buttons,
   * 42-day final-review badge, post-wedding affordances) can avoid
   * rendering for couples who are >42 days out, per Sarah's audit.
   */
  weddingDate: string | null
  loading: boolean
  isDemo: boolean
}

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'
const DEMO_WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const DEMO_SLUG = 'hawthorne-manor'
/**
 * What we call the assistant before we know what the venue calls it.
 * Never a real name, and never Bloom's.
 */
const DEFAULT_AI_NAME = 'your AI assistant'

/**
 * Server-seeded AI name.
 *
 * The couple layout already queries the venue on the server, so it can
 * hand the real name down and the first paint is correct. Without this
 * the hook fetches venue_ai_config in a browser effect and every
 * "Ask ..." label visibly changes a beat after the page appears.
 */
const CoupleAiNameContext = createContext<string | null>(null)

export function CoupleAiNameProvider({
  aiName,
  children,
}: {
  aiName: string | null
  children: React.ReactNode
}) {
  return createElement(CoupleAiNameContext.Provider, { value: aiName }, children)
}

/**
 * Synchronously detect demo mode from the document cookie.
 * Used as the initial state so the very first render already has IDs
 * (queries don't fire with null wedding_id on first paint).
 *
 * Two cookie shapes both indicate "this is a demo session":
 *   - bloom_demo=true        : legacy value cookie (set by the
 *                              /demo/* rewrite path in middleware).
 *   - bloom_demo_hint=1      : non-HttpOnly hint set by the /demo
 *                              Server Action that mints the signed
 *                              bloom_demo_token. Pre-fix this hook
 *                              only checked the legacy cookie, so
 *                              visitors entering via the new /demo
 *                              flow had venueId/weddingId stay null
 *                              and every couple-portal page hung
 *                              on its loading spinner.
 *
 * The hint cookie is non-HttpOnly because client-side code (this hook,
 * top-bar demo banner, etc.) needs to know "is this a demo" without
 * reading the signed token. The hint alone never grants real-data
 * access — server-side reads still go through anon RLS, which gates
 * by is_demo=true at the venue level (mig 064).
 */
function detectDemoSync(): boolean {
  if (typeof document === 'undefined') return false
  const cookies = document.cookie.split('; ')
  return cookies.some((c) => c === 'bloom_demo=true' || c === 'bloom_demo_hint=1')
}

export function useCoupleContext(): CoupleContext {
  const params = useParams<{ slug?: string }>()
  const slug = params?.slug || DEMO_SLUG
  const seededAiName = useContext(CoupleAiNameContext)

  // Initialize state synchronously for demo mode so the first render
  // already has the right IDs — no flash of wedding_id=null queries.
  const initialDemo = detectDemoSync()
  const [venueId, setVenueId] = useState<string | null>(initialDemo ? DEMO_VENUE_ID : null)
  const [weddingId, setWeddingId] = useState<string | null>(initialDemo ? DEMO_WEDDING_ID : null)
  const [aiName, setAiName] = useState<string>(seededAiName?.trim() || DEFAULT_AI_NAME)
  const [venueName, setVenueName] = useState<string>('')
  const [weddingDate, setWeddingDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(!initialDemo)
  const [isDemo, setIsDemo] = useState(initialDemo)

  // Keep in step if a navigation swaps the seeded value.
  useEffect(() => {
    const seeded = seededAiName?.trim()
    if (seeded) setAiName(seeded)
  }, [seededAiName])

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
      // defaults if the rows are missing. Skipped when the server layout
      // already seeded a name, which is the common case.
      const [{ data: aiConfig }, { data: cfg }] = await Promise.all([
        seededAiName?.trim()
          ? Promise.resolve({ data: null })
          : supabase.from('venue_ai_config').select('ai_name').eq('venue_id', venue.id).maybeSingle(),
        supabase.from('venue_config').select('business_name').eq('venue_id', venue.id).maybeSingle(),
      ])
      const resolvedAiName = (aiConfig?.ai_name as string | null)?.trim()
      if (resolvedAiName) setAiName(resolvedAiName)
      const resolvedBusinessName = (cfg?.business_name as string | null)?.trim()
      if (resolvedBusinessName) setVenueName(resolvedBusinessName)

      // Resolve the wedding for the signed-in couple.
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        // user_profiles is the truth here. Migration 226's RLS helper
        // couple_user_wedding_id() reads user_profiles.wedding_id, so
        // every row the couple can actually see is scoped by it. This
        // hook used to resolve through people.email instead, which meant
        // a couple whose people row carried a different address, or none,
        // got a wedding_id the database would then refuse to serve, or no
        // wedding at all. people stays as a fallback for accounts created
        // before the profile row was mandatory.
        let resolvedWeddingId: string | null = null

        const { data: profile } = await supabase
          .from('user_profiles')
          .select('wedding_id')
          .eq('id', user.id)
          .eq('role', 'couple')
          .maybeSingle()
        resolvedWeddingId = (profile?.wedding_id as string | null) ?? null

        if (!resolvedWeddingId && user.email) {
          const { data: person } = await supabase
            .from('people')
            .select('wedding_id')
            .eq('email', user.email)
            .in('role', ['partner1', 'partner2'])
            .eq('venue_id', venue.id)
            .maybeSingle()
          resolvedWeddingId = (person?.wedding_id as string | null) ?? null
        }

        if (resolvedWeddingId) {
          setWeddingId(resolvedWeddingId)
          // Fetch the wedding_date for visibility-gated UI. Best-
          // effort — falls through to null on missing row.
          const { data: w } = await supabase
            .from('weddings')
            .select('wedding_date')
            .eq('id', resolvedWeddingId)
            .maybeSingle()
          if (w?.wedding_date) setWeddingDate(w.wedding_date as string)
        }
      }

      setLoading(false)
    }

    resolve()
  }, [slug, initialDemo, seededAiName])

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

  return { slug, venueId, weddingId, aiName, venueName, weddingDate, loading, isDemo }
}
