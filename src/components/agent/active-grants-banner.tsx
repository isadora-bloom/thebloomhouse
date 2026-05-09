'use client'

/**
 * Active grants banner — Bug 6 (2026-05-09).
 *
 * Renders "N standing rules are active — view" when the venue has any
 * active brain-dump pattern grants. Used on /agent/notifications and
 * /agent/brain-dump so a coordinator can never forget that they
 * authorised auto-routing months ago: every visit to the alert
 * surfaces shows the count + a link to revoke.
 *
 * Self-hides when the count is zero so the banner doesn't add noise
 * for venues that haven't graduated any patterns yet.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, ArrowRight } from 'lucide-react'

interface GrantsResponse {
  grants: Array<{
    id: string
    is_active?: boolean
    revoked_at: string | null
  }>
}

export function ActiveGrantsBanner() {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/brain-dump/grants')
        if (!res.ok) return
        const json = (await res.json()) as GrantsResponse
        if (cancelled) return
        // Filter on is_active true (when present) AND revoked_at null —
        // belt and suspenders for any rows that might have only one of
        // the two markers set during the migration window.
        const active = json.grants.filter(
          (g) => (g.is_active ?? true) && !g.revoked_at,
        ).length
        setCount(active)
      } catch {
        // Silent — banner self-hides on error.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (count === null || count === 0) return null

  return (
    <Link
      href="/agent/brain-dump/grants"
      className="flex items-center gap-3 rounded-lg border border-sage-200 bg-sage-50/60 hover:bg-sage-100/60 px-4 py-2.5 transition-colors"
    >
      <Sparkles className="w-4 h-4 text-sage-600 shrink-0" />
      <span className="text-sm text-sage-800 flex-1">
        <strong className="font-semibold">{count}</strong> standing rule{count === 1 ? '' : 's'}{' '}
        currently auto-route brain-dump entries. View or revoke.
      </span>
      <ArrowRight className="w-4 h-4 text-sage-500 shrink-0" />
    </Link>
  )
}
