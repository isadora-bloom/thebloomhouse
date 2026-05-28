'use client'

/**
 * Couple-side "mark this section complete" footer.
 *
 * Mounted once in CoupleShell. Reads pathname → derives slug →
 * looks up SECTIONS registry. If the slug is actionable, renders a
 * footer bar; otherwise renders nothing.
 *
 * 2026-05-26 — pairs with the sidebar status dots. Without this,
 * couples couldn't flip a section to green outside the Final Review
 * 6-week window. Now they can mark any actionable section done at
 * any time and undo it.
 *
 * Refresh signal: on toggle, dispatches a `couple-section-status-changed`
 * window event. The sidebar listens and re-runs loadSectionStatuses so
 * the dot updates immediately without a page reload.
 */

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { Check, Loader2, RotateCcw } from 'lucide-react'
import { getSectionDef } from '@/lib/services/couple/section-status'

export const SECTION_STATUS_CHANGED_EVENT = 'couple-section-status-changed'

interface Finalisation {
  id: string
  couple_signed_off: boolean
  couple_signed_off_at: string | null
}

function slugFromPathname(pathname: string | null): string | null {
  if (!pathname) return null
  // /couple/<venue>/<slug>...
  const m = pathname.match(/^\/couple\/[^/]+\/([^/?#]+)/)
  return m ? m[1] : null
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function MarkSectionCompleteBar() {
  const pathname = usePathname()
  const { venueId, weddingId } = useCoupleContext()

  const slug = slugFromPathname(pathname)
  const sectionDef = slug ? getSectionDef(slug) : undefined

  const [state, setState] = useState<Finalisation | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Load existing finalisation on mount / slug change.
  useEffect(() => {
    if (!sectionDef || !weddingId) {
      setState(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    // Two simultaneous tabs marking the same section can insert
    // duplicate rows (no unique constraint on wedding_id+section_name
    // in mig 009). order + limit(1) ensures the newest row wins and
    // .maybeSingle() doesn't throw on >1 rows.
    supabase
      .from('section_finalisations')
      .select('id, couple_signed_off, couple_signed_off_at')
      .eq('wedding_id', weddingId)
      .eq('section_name', sectionDef.finalisationKey)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setState((data as Finalisation | null) ?? null)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [weddingId, sectionDef])

  // Nothing to render for read-only / meta sections.
  if (!sectionDef || !venueId || !weddingId) return null
  if (loading) {
    return (
      <div className="mt-10 pt-6 border-t border-gray-100 flex items-center justify-end text-xs text-gray-400">
        <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
        Loading status…
      </div>
    )
  }

  const isMarkedDone = state?.couple_signed_off === true

  async function toggle() {
    if (!sectionDef || !venueId || !weddingId) return
    setSaving(true)
    const supabase = createClient()
    const nowIso = new Date().toISOString()
    try {
      const nextValue = state?.id ? !isMarkedDone : true
      // Single upsert keyed by (wedding_id, section_name) — mig 372
      // added the unique constraint that makes this reliable. Handles
      // both first-time signoff AND a racing second tab without
      // a separate insert/update branch.
      const { data, error } = await supabase
        .from('section_finalisations')
        .upsert(
          {
            venue_id: venueId,
            wedding_id: weddingId,
            section_name: sectionDef.finalisationKey,
            couple_signed_off: nextValue,
            couple_signed_off_at: nextValue ? nowIso : null,
          },
          { onConflict: 'wedding_id,section_name' }
        )
        .select('id, couple_signed_off, couple_signed_off_at')
        .single()
      if (error) throw error
      setState(data as Finalisation)

      // Signal the sidebar (and anyone else listening) that statuses
      // changed so they can refetch without a hard reload.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(SECTION_STATUS_CHANGED_EVENT))
      }
    } catch (err) {
      console.error('[MarkSectionCompleteBar] toggle failed:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-10 pt-6 border-t border-gray-100 flex flex-wrap items-center justify-end gap-3 no-print">
      {isMarkedDone ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700">
            <Check className="w-3.5 h-3.5" />
            Marked complete{state?.couple_signed_off_at && ` · ${formatDate(state.couple_signed_off_at)}`}
          </span>
          <button
            onClick={toggle}
            disabled={saving}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            Undo
          </button>
        </>
      ) : (
        <>
          <span className="text-xs text-gray-400">Done with this section?</span>
          <button
            onClick={toggle}
            disabled={saving}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Mark complete
          </button>
        </>
      )}
    </div>
  )
}
