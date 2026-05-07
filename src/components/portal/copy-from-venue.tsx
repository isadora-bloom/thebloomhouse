'use client'

/**
 * Reusable "Copy from another venue" button for portal/*-config pages.
 * Tier-B #69C.
 *
 * Usage:
 *   <CopyFromVenueButton table="marketing_channels" onCopied={refresh} />
 *
 * Renders nothing for single-venue orgs (no sister to copy from).
 * Loads sister venues lazily on first click via /api/agent/scope-venues
 * which already does the org-aware lookup. Posts to
 * /api/portal/config/copy with the table + source venue id.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Copy, Loader2 } from 'lucide-react'

interface CopyFromVenueButtonProps {
  /** Table name (must be in /api/portal/config/copy ALLOWED_TABLES). */
  table: string
  /** Fired after the copy succeeds so the parent can refetch. */
  onCopied?: (copied: number) => void
  /** Override label. Default "Copy from another venue". */
  label?: string
}

interface SisterVenue {
  id: string
  name: string
}

export function CopyFromVenueButton({
  table,
  onCopied,
  label = 'Copy from another venue',
}: CopyFromVenueButtonProps) {
  const [sisters, setSisters] = useState<SisterVenue[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  // Resolve sister venues once. Looks at the calling user's
  // user_profiles.org_id and lists every other venue in the same org.
  // RLS gates the read so cross-org attempts return zero.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const supabase = createClient()
      const { data: meRows } = await supabase.auth.getUser()
      const userId = meRows?.user?.id
      if (!userId) return
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('org_id, venue_id')
        .eq('id', userId)
        .maybeSingle()
      if (!profile?.org_id || !profile?.venue_id) {
        setSisters([])
        return
      }
      const { data: orgVenues } = await supabase
        .from('venues')
        .select('id, name')
        .eq('org_id', profile.org_id)
        .neq('id', profile.venue_id)
        .order('name')
      if (cancelled) return
      setSisters((orgVenues as SisterVenue[] | null) ?? [])
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // Solo-org: render nothing. There's no sister to copy from.
  if (sisters !== null && sisters.length === 0) return null

  async function handleCopy(sourceVenueId: string) {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await fetch('/api/portal/config/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table, sourceVenueId }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Copy failed')
        return
      }
      const copied = body?.data?.copied ?? 0
      setDone(copied)
      onCopied?.(copied)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sage-200 bg-white text-sage-700 hover:bg-sage-50 text-xs font-medium"
      >
        <Copy className="w-3.5 h-3.5" />
        {label}
      </button>

      {open && sisters && sisters.length > 0 && (
        <div className="absolute right-0 z-10 mt-2 w-72 rounded-lg border border-sage-200 bg-white shadow-lg p-3">
          <p className="text-xs text-sage-500 mb-2">
            Copy this venue&apos;s config from a sister venue. Existing rows
            stay; new ones are added.
          </p>
          <div className="space-y-1">
            {sisters.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleCopy(s.id)}
                disabled={busy}
                className="w-full text-left px-3 py-2 rounded-md text-sm text-sage-800 hover:bg-sage-50 disabled:opacity-50 flex items-center gap-2"
              >
                {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                {s.name}
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
        </div>
      )}

      {done !== null && (
        <p className="text-xs text-sage-500 mt-1">
          Copied {done} {done === 1 ? 'row' : 'rows'}.
        </p>
      )}
    </div>
  )
}
