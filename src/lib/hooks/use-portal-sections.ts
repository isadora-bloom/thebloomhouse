'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { OpenSection } from '@/lib/services/couple/section-visibility'

/**
 * The venue's section settings as the couple side needs them: which
 * sections are on (and released), and whether the venue's soft close
 * has passed for this wedding. Both are read-only here; the venue sets
 * them at /portal/section-settings.
 *
 * `open` is null until loaded so callers can avoid flashing a gate.
 */
export function usePortalSections(venueSlug: string | null, weddingId: string | null) {
  const [open, setOpen] = useState<OpenSection[] | null>(null)
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    if (!venueSlug) return
    let cancelled = false
    fetch(`/api/portal/section-config?slug=${encodeURIComponent(venueSlug)}&couple=true`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j: { data?: OpenSection[] }) => {
        if (!cancelled) setOpen(j.data ?? [])
      })
      .catch(() => {
        if (!cancelled) setOpen([])
      })
    return () => {
      cancelled = true
    }
  }, [venueSlug])

  useEffect(() => {
    if (!weddingId) return
    let cancelled = false
    createClient()
      .rpc('portal_is_closed', { p_wedding_id: weddingId })
      .then(({ data }) => {
        if (!cancelled) setClosed(data === true)
      })
    return () => {
      cancelled = true
    }
  }, [weddingId])

  return { open, closed }
}
