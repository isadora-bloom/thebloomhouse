'use client'

/**
 * Read-only addresses section for the coordinator wedding-detail page.
 * B2 starting cut.
 *
 * Couple enters addresses on /couple/[slug]/addresses; this surface
 * shows them to the venue's coordinators alongside the rest of the
 * wedding profile. Empty state when the couple hasn't filled anything.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { MapPin, Loader2 } from 'lucide-react'

interface AddressPersonRow {
  id: string
  role: string
  first_name: string | null
  last_name: string | null
  address_label: string | null
  street_line_1: string | null
  street_line_2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
}

function hasAddress(p: AddressPersonRow): boolean {
  return Boolean(p.street_line_1 || p.city || p.postal_code)
}

function formatLines(p: AddressPersonRow): string[] {
  const lines: string[] = []
  if (p.street_line_1) lines.push(p.street_line_1)
  if (p.street_line_2) lines.push(p.street_line_2)
  const cityRegion = [p.city, p.region].filter(Boolean).join(', ')
  if (cityRegion || p.postal_code) {
    lines.push([cityRegion, p.postal_code].filter(Boolean).join(' '))
  }
  if (p.country && p.country.toLowerCase() !== 'usa' && p.country.toLowerCase() !== 'us') {
    lines.push(p.country)
  }
  return lines
}

function rowLabel(p: AddressPersonRow): string {
  if (p.role === 'parent') {
    return p.address_label || p.first_name || 'Family member'
  }
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ')
  if (name) return name
  return p.role === 'partner1' ? 'Partner 1' : p.role === 'partner2' ? 'Partner 2' : p.role
}

export function WeddingAddressesSection({ weddingId }: { weddingId: string }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<AddressPersonRow[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from('people')
        .select('id, role, first_name, last_name, address_label, street_line_1, street_line_2, city, region, postal_code, country')
        .eq('wedding_id', weddingId)
        .in('role', ['partner1', 'partner2', 'parent'])
        .order('role')
      if (!cancelled) {
        setRows(((data ?? []) as AddressPersonRow[]).filter(hasAddress))
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [weddingId])

  if (loading) {
    return (
      <div className="bg-warm-white border border-border rounded-xl p-4 flex items-center gap-2 text-sm text-sage-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading addresses
      </div>
    )
  }

  return (
    <div className="bg-warm-white border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-teal-600" />
        <h3 className="text-sm font-semibold text-sage-900">Addresses</h3>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-sage-500 italic">
          The couple has not entered any addresses yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {rows.map((p) => (
            <div key={p.id} className="bg-surface border border-border rounded-lg p-3">
              <p className="text-xs uppercase tracking-wider text-sage-500 mb-1">
                {p.role === 'parent' ? 'Family' : (p.role === 'partner1' ? 'Partner 1' : 'Partner 2')}
              </p>
              <p className="text-sm font-medium text-sage-900">{rowLabel(p)}</p>
              <div className="text-xs text-sage-700 mt-1 space-y-0.5">
                {formatLines(p).map((l, i) => <p key={i}>{l}</p>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
