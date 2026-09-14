'use client'

/**
 * The couple's day-of timeline page.
 *
 * The builder itself lives in src/components/couple/timeline-builder.tsx
 * now, because the coordinator's wedding page renders the same one with
 * role "coordinator" and can edit it during a walkthrough. This page is
 * the couple's half: it resolves the couple context and hands the builder
 * the wedding id, the venue id and the name the CSV export uses.
 *
 * Nothing about the couple's experience changed in the move.
 */

import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { TimelineBuilder } from '@/components/couple/timeline-builder'

export default function TimelinePage() {
  const { slug, venueId, weddingId, loading: contextLoading } = useCoupleContext()

  return (
    <TimelineBuilder
      weddingId={weddingId}
      venueId={venueId}
      role="couple"
      exportName={slug}
      contextLoading={contextLoading}
    />
  )
}
