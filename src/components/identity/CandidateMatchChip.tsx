'use client'

/**
 * Inline candidate-match surfacing for the inbox.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §5 Don't skip #2
 *   "I will build the review queue page and call it done. Susan
 *    won't visit it. Candidates must also appear inline on the lead
 *    detail and inline on the inbox where the relevant signal is."
 *
 * The chip looks up open candidate_matches for the couple mirrored
 * from the legacy wedding_id this interaction lives under. Renders
 * nothing when there are no open candidates (so the inbox stays
 * uncluttered for the common case).
 *
 * Click navigates to /intel/identity-review.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { HelpCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface Props {
  /** Legacy wedding id from the interactions row. We resolve to the
   *  mirrored couple via couples.source_wedding_id. */
  weddingId: string | null | undefined
}

export function CandidateMatchChip({ weddingId }: Props) {
  const [count, setCount] = useState<number>(0)
  const [coupleId, setCoupleId] = useState<string | null>(null)

  useEffect(() => {
    if (!weddingId) return
    let cancelled = false
    const supabase = createClient()
    const load = async () => {
      const { data: c } = await supabase
        .from('couples')
        .select('id')
        .eq('source_wedding_id', weddingId)
        .maybeSingle()
      if (cancelled) return
      const id = (c as { id: string } | null)?.id ?? null
      setCoupleId(id)
      if (!id) {
        setCount(0)
        return
      }
      const { count: n } = await supabase
        .from('candidate_matches')
        .select('id', { count: 'exact', head: true })
        .or(`primary_record_id.eq.${id},secondary_record_id.eq.${id}`)
        .is('resolution', null)
      if (cancelled) return
      setCount(n ?? 0)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [weddingId])

  if (count === 0 || !coupleId) return null
  return (
    <Link
      href="/intel/identity-review"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100"
      title="Open in identity review queue"
    >
      <HelpCircle className="h-2.5 w-2.5" />
      {count} possible match{count > 1 ? 'es' : ''}
    </Link>
  )
}
