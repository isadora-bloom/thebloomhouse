'use client'

/**
 * Journey narrative widget (Phase C / PC.3).
 *
 * Sits at the top of /intel/clients/[id], between the header and the
 * contact-info card grid. Pulls the AI-generated paragraph from
 * /api/intel/journey-narrative — lazy gen on first view, cached on
 * subsequent views, regenerable via the menu.
 *
 * Self-hides when the wedding has no resolved candidates (nothing
 * to narrate) so the page doesn't get an empty box.
 */

import { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, Pin, PinOff, Loader2 } from 'lucide-react'

interface NarrativeShape {
  text: string
  cached: boolean
  generated_at: string
  signal_count: number
  attribution_count: number
}

interface Props {
  weddingId: string
}

export function JourneyNarrative({ weddingId }: Props) {
  const [narrative, setNarrative] = useState<NarrativeShape | null>(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/intel/journey-narrative?wedding_id=${weddingId}`)
        if (!res.ok) {
          setNarrative(null)
        } else {
          const json = (await res.json()) as { narrative: NarrativeShape | null }
          if (!cancelled) setNarrative(json.narrative)
        }
      } catch {
        if (!cancelled) setNarrative(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [weddingId])

  async function regenerate() {
    setRegenerating(true)
    try {
      const res = await fetch('/api/intel/journey-narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wedding_id: weddingId, force: true }),
      })
      if (res.ok) {
        const json = (await res.json()) as { narrative: NarrativeShape | null }
        setNarrative(json.narrative)
      }
    } finally {
      setRegenerating(false)
    }
  }

  async function togglePin() {
    if (pinned) return // unpinning would require a separate endpoint; keep simple
    const res = await fetch('/api/intel/journey-narrative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wedding_id: weddingId, pin: true }),
    })
    if (res.ok) setPinned(true)
  }

  // Loading state intentionally subtle — first-view gen takes a few
  // seconds and we don't want a giant spinner banner.
  if (loading) {
    return (
      <div className="bg-sage-50/40 border border-sage-100 rounded-xl px-4 py-3 flex items-center gap-3 text-sm text-sage-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Composing journey…
      </div>
    )
  }

  if (!narrative) return null

  return (
    <div className="bg-gradient-to-br from-sage-50/80 to-warm-white border border-sage-100 rounded-xl px-5 py-4 shadow-sm">
      <div className="flex items-start gap-3">
        <Sparkles className="w-4 h-4 text-sage-500 mt-1 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-sage-800 leading-relaxed">{narrative.text}</p>
          <div className="flex items-center gap-3 mt-2 text-[11px] text-sage-400">
            <span>
              {narrative.cached ? 'Cached' : 'Just generated'} · {narrative.signal_count} signal
              {narrative.signal_count === 1 ? '' : 's'} · {narrative.attribution_count} attribution
              {narrative.attribution_count === 1 ? '' : 's'}
            </span>
            <button
              onClick={regenerate}
              disabled={regenerating}
              className="hover:text-sage-700 inline-flex items-center gap-1 disabled:opacity-50"
              title="Regenerate the narrative"
            >
              <RefreshCw className={`w-3 h-3 ${regenerating ? 'animate-spin' : ''}`} />
              {regenerating ? 'Regenerating' : 'Regenerate'}
            </button>
            <button
              onClick={togglePin}
              className="hover:text-sage-700 inline-flex items-center gap-1"
              title={pinned ? 'Pinned (won\'t auto-regenerate)' : 'Pin to lock this narrative'}
            >
              {pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
              {pinned ? 'Pinned' : 'Pin'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
