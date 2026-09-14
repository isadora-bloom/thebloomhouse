'use client'

/**
 * The three sections a final walkthrough needs, on the page the
 * coordinator already has open.
 *
 * From the Monday walkthrough audit (2026-09-14). The wedding page was
 * good for guests, vendors, budget and notes, and then the meeting broke
 * three times in a row:
 *
 *   - the reconstructed couple story lived only on the Intelligence
 *     couple page, so the person in the room with the couple was the one
 *     who could not see what the couple had told us;
 *   - the couple could search their own contracts and the coordinator saw
 *     "contract uploaded: yes";
 *   - the couple had a running-order builder and the coordinator had a
 *     read-only list.
 *
 * All three are fixed by rendering what already exists rather than by
 * writing a coordinator's copy of it. The story uses the same card and
 * the same adapter as /intel/couples/[id]. The contracts and the timeline
 * use the couple portal's own components, now shared, with a role.
 *
 * Headings come from src/lib/copy/client-terms.ts, so a coordinator never
 * reads the words "identity profile" on their own page.
 */

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { clientTerm } from '@/lib/copy/client-terms'
import { EmptyState } from '@/components/ui/empty-state'
import { Heart } from 'lucide-react'
import { IdentityProfileCard } from '@/app/(platform)/intel/_canonical/identity-profile-card'
import { useCoupleJourney } from '@/app/(platform)/intel/_canonical/use-journey'
import { cn } from '@/lib/utils'

/** Sentence case for a heading taken from the client-terms map, whose
 *  values are written lower case so they read inside sentences too. */
function asHeading(term: string): string {
  if (!term) return ''
  return term.charAt(0).toUpperCase() + term.slice(1)
}

export const WALKTHROUGH_HEADINGS = {
  story: asHeading(clientTerm('couple story')),
  contracts: asHeading(clientTerm('contracts')),
  timeline: asHeading(clientTerm('timeline')),
}

// ---------------------------------------------------------------------------
// Collapsible shell
// ---------------------------------------------------------------------------

export function CollapsibleSection({
  heading,
  subheading,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  heading: string
  subheading?: string
  icon: React.ComponentType<{ className?: string }>
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-sage-50/50 transition-colors"
      >
        <Icon className="w-4 h-4 text-sage-500 shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block font-heading text-base font-semibold text-sage-900">
            {heading}
          </span>
          {subheading && (
            <span className="block text-xs text-sage-500 mt-0.5">{subheading}</span>
          )}
        </span>
        {open ? (
          <ChevronDown className="w-4 h-4 text-sage-400 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-sage-400 shrink-0" />
        )}
      </button>
      {/* Mounted only while open. The timeline builder and the contract
          list each fetch on mount, so a collapsed section costs nothing. */}
      {open && <div className={cn('border-t border-border p-5')}>{children}</div>}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Couple story
// ---------------------------------------------------------------------------

type Lookup = 'loading' | 'found' | 'none' | 'error'

/**
 * The reconstructed couple story, on the wedding page.
 *
 * The profile is keyed on wedding id (migration 260) but the canonical
 * reader is keyed on couple id, so the one hop this needs is
 * couples.source_wedding_id back to a couple. That read goes through the
 * couples_select policy of migration 346, which is the same venue scope
 * the rest of this page already runs under.
 *
 * A wedding with no mirrored couple is a real and common state, not an
 * error, and it says so.
 */
export function CoupleStorySection({
  weddingId,
  venueId,
}: {
  weddingId: string
  venueId: string
}) {
  const [coupleId, setCoupleId] = useState<string | null>(null)
  const [lookup, setLookup] = useState<Lookup>('loading')

  const findCouple = useCallback(async () => {
    setLookup('loading')
    const supabase = createClient()
    const { data, error } = await supabase
      .from('couples')
      .select('id')
      .eq('source_wedding_id', weddingId)
      .eq('venue_id', venueId)
      .maybeSingle()

    if (error) {
      setLookup('error')
      return
    }
    if (!data) {
      setLookup('none')
      return
    }
    setCoupleId(data.id as string)
    setLookup('found')
  }, [weddingId, venueId])

  useEffect(() => {
    void findCouple()
  }, [findCouple])

  const { journey, loading: journeyLoading, error: journeyError } = useCoupleJourney(coupleId)

  if (lookup === 'loading') {
    return <div className="h-24 rounded-lg bg-sage-50 animate-pulse" />
  }

  if (lookup === 'error') {
    return (
      <EmptyState
        icon={Heart}
        title="Could not look this couple up"
        subtitle="The wedding is here, but the lookup that joins it to the couple record did not answer. Nothing is lost; try again in a moment."
        variant="dashed"
      />
    )
  }

  if (lookup === 'none') {
    return (
      <EmptyState
        icon={Heart}
        title="No couple record joined to this wedding yet"
        subtitle="The story is reconstructed against a couple record, and this wedding has not been mirrored to one. That happens with weddings typed in by hand rather than arriving as an enquiry. Nothing has been attempted for them, which is different from having looked and found nothing."
        variant="dashed"
      />
    )
  }

  if (journeyLoading) {
    return <div className="h-24 rounded-lg bg-sage-50 animate-pulse" />
  }

  if (journeyError) {
    return (
      <EmptyState
        icon={Heart}
        title="Could not read the story"
        subtitle={journeyError}
        variant="dashed"
      />
    )
  }

  // The card handles the empty profile, the refusals and the claims marked
  // sensitive. Nothing about that handling is re-implemented here.
  return (
    <IdentityProfileCard
      profile={journey?.identityProfile ?? null}
      hasSourceWedding
    />
  )
}
