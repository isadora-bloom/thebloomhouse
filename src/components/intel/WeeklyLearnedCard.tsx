'use client'

import { useEffect, useState } from 'react'
import { Sparkles, Calendar, Target, GitCompare } from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'

// ---------------------------------------------------------------------------
// Types (mirror the API response)
// ---------------------------------------------------------------------------

interface WeeklyLearnedBullet {
  kind: 'voice' | 'booking' | 'source' | 'correlation'
  text: string
  empty?: boolean
}

interface WeeklyLearnedResponse {
  aiName: string
  bullets: WeeklyLearnedBullet[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iconFor(kind: WeeklyLearnedBullet['kind']) {
  switch (kind) {
    case 'voice':
      return Sparkles
    case 'booking':
      return Calendar
    case 'source':
      return Target
    case 'correlation':
      return GitCompare
  }
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

export function WeeklyLearnedCard() {
  const scope = useScope()
  const [data, setData] = useState<WeeklyLearnedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (scope.loading) return

    // Only venue-scoped. Multi-venue dashboards shouldn't surface one
    // venue's voice bullet arbitrarily.
    if (scope.level !== 'venue' || !scope.venueId) {
      setHidden(true)
      setLoading(false)
      return
    }

    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const res = await fetch(
          `/api/intel/weekly-learned?venue_id=${scope.venueId}`
        )
        if (!res.ok) {
          // Plan-gated or auth. Stay silent rather than shout at the user.
          if (res.status === 401 || res.status === 402 || res.status === 403) {
            if (!cancelled) {
              setHidden(true)
              setLoading(false)
            }
            return
          }
          throw new Error(`Request failed: ${res.status}`)
        }
        const json = (await res.json()) as WeeklyLearnedResponse
        if (cancelled) return
        setData(json)
      } catch (err) {
        console.error('[WeeklyLearnedCard] load error:', err)
        if (!cancelled) setHidden(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [scope.loading, scope.level, scope.venueId])

  if (hidden) return null

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
        <div className="h-5 w-64 bg-sage-100 rounded animate-pulse mb-4" />
        <div className="space-y-3">
          <div className="h-4 bg-sage-50 rounded animate-pulse" />
          <div className="h-4 bg-sage-50 rounded animate-pulse" />
          <div className="h-4 bg-sage-50 rounded animate-pulse" />
        </div>
      </div>
    )
  }

  if (!data) return null

  const aiName = data.aiName || 'Your AI assistant'

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-5 h-5 text-sage-600" />
        <h2 className="font-heading text-lg font-semibold text-sage-900">
          What {aiName} learned this week
        </h2>
      </div>

      <ul className="space-y-3">
        {data.bullets.map((bullet, idx) => {
          const Icon = iconFor(bullet.kind)
          const textClass = bullet.empty
            ? 'text-sage-400 italic'
            : 'text-sage-900'
          return (
            <li key={`${bullet.kind}-${idx}`} className="flex items-start gap-3">
              <Icon
                className={`w-4 h-4 shrink-0 mt-0.5 ${bullet.empty ? 'text-sage-300' : 'text-sage-600'}`}
              />
              <p className={`text-sm leading-relaxed ${textClass}`}>
                {bullet.text}
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
