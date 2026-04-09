'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  ClipboardCheck,
  Check,
  AlertCircle,
  Clock,
  Shield,
  Lock,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

interface Finalisation {
  id: string
  section_name: string
  couple_signed_off: boolean
  couple_signed_off_at: string | null
  staff_signed_off: boolean
  staff_signed_off_at: string | null
}

interface WeddingInfo {
  wedding_date: string | null
}

interface SectionDef {
  key: string
  label: string
  description: string
}

const SECTIONS: SectionDef[] = [
  { key: 'timeline', label: 'Timeline', description: 'Day-of schedule and flow' },
  { key: 'ceremony', label: 'Ceremony Lineup', description: 'Processional order, readings, music' },
  { key: 'guests', label: 'Guest List', description: 'Final headcount and RSVPs' },
  { key: 'seating', label: 'Seating Chart', description: 'Table assignments confirmed' },
  { key: 'vendors', label: 'Vendors', description: 'All vendor contacts and contracts' },
  { key: 'beauty', label: 'Hair & Makeup', description: 'Schedule and contacts' },
  { key: 'transportation', label: 'Transportation', description: 'Shuttles, parking, logistics' },
  { key: 'rehearsal', label: 'Rehearsal', description: 'Rehearsal and dinner details' },
  { key: 'rooms', label: 'Room Assignments', description: 'Getting-ready rooms and overnight stays' },
  { key: 'decor', label: 'Decor & Setup', description: 'Decorations, layout, vendor drop-off' },
  { key: 'allergies', label: 'Allergies & Dietary', description: 'Guest allergy registry reviewed' },
  { key: 'staffing', label: 'Staffing', description: 'Day-of staff and assignments' },
  { key: 'bar', label: 'Bar & Beverages', description: 'Bar plan, recipes, shopping list' },
  { key: 'budget', label: 'Budget', description: 'Final payments and gratuities' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusOfSection(f: Finalisation | undefined) {
  if (!f) return 'none'
  if (f.couple_signed_off && f.staff_signed_off) return 'complete'
  if (f.couple_signed_off || f.staff_signed_off) return 'partial'
  return 'none'
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Final Review Page
// ---------------------------------------------------------------------------

export default function FinalReviewPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [finalisations, setFinalisations] = useState<Finalisation[]>([])
  const [wedding, setWedding] = useState<WeddingInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [finRes, wedRes] = await Promise.all([
      supabase
        .from('section_finalisations')
        .select('*')
        .eq('wedding_id', weddingId),
      supabase
        .from('weddings')
        .select('wedding_date')
        .eq('id', weddingId)
        .single(),
    ])

    if (!finRes.error && finRes.data) {
      setFinalisations(finRes.data as Finalisation[])
    }
    if (!wedRes.error && wedRes.data) {
      setWedding(wedRes.data as WeddingInfo)
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Computed ----
  const weeksUntilWedding = wedding?.wedding_date
    ? Math.max(0, Math.ceil(
        (new Date(wedding.wedding_date).getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000)
      ))
    : null

  const isWithinWindow = weeksUntilWedding !== null && weeksUntilWedding <= 6

  function getFinalisation(sectionKey: string): Finalisation | undefined {
    return finalisations.find((f) => f.section_name === sectionKey)
  }

  async function toggleCoupleSignOff(sectionKey: string) {
    const existing = getFinalisation(sectionKey)

    if (existing) {
      const newValue = !existing.couple_signed_off
      await supabase
        .from('section_finalisations')
        .update({
          couple_signed_off: newValue,
          couple_signed_off_at: newValue ? new Date().toISOString() : null,
        })
        .eq('id', existing.id)
    } else {
      await supabase.from('section_finalisations').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        section_name: sectionKey,
        couple_signed_off: true,
        couple_signed_off_at: new Date().toISOString(),
      })
    }

    fetchData()
  }

  // Stats
  const stats = {
    complete: SECTIONS.filter((s) => statusOfSection(getFinalisation(s.key)) === 'complete').length,
    partial: SECTIONS.filter((s) => statusOfSection(getFinalisation(s.key)) === 'partial').length,
    none: SECTIONS.filter((s) => statusOfSection(getFinalisation(s.key)) === 'none').length,
  }

  if (contextLoading || !weddingId || !venueId || loading) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-gray-100 rounded-lg w-64 animate-pulse" />
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  // Not yet in window
  if (!isWithinWindow) {
    return (
      <div className="space-y-6">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Final Review
          </h1>
          <p className="text-gray-500 text-sm">
            The final review opens when your wedding is within 6 weeks.
          </p>
        </div>

        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Lock className="w-12 h-12 mx-auto mb-4 text-gray-300" />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Not quite yet
          </h3>
          <p className="text-gray-500 text-sm max-w-md mx-auto">
            {weeksUntilWedding !== null
              ? `Your wedding is ${weeksUntilWedding} weeks away. The final review will open when you're within 6 weeks. Keep planning!`
              : 'Set your wedding date in your profile to see when the final review opens.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Final Review
        </h1>
        <p className="text-gray-500 text-sm">
          {weeksUntilWedding !== null && `${weeksUntilWedding} weeks to go. `}
          Confirm each section is ready, then your coordinator signs off.
        </p>
      </div>

      {/* Status Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-100 text-center">
          <p className="text-2xl font-bold text-emerald-700 tabular-nums">{stats.complete}</p>
          <p className="text-xs text-emerald-600 font-medium">Confirmed</p>
        </div>
        <div className="bg-amber-50 rounded-xl p-4 border border-amber-100 text-center">
          <p className="text-2xl font-bold text-amber-700 tabular-nums">{stats.partial}</p>
          <p className="text-xs text-amber-600 font-medium">In Progress</p>
        </div>
        <div className="bg-gray-50 rounded-xl p-4 border border-gray-200 text-center">
          <p className="text-2xl font-bold text-gray-600 tabular-nums">{stats.none}</p>
          <p className="text-xs text-gray-500 font-medium">Not Started</p>
        </div>
      </div>

      {/* Explanation */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <h3 className="text-sm font-medium text-gray-700 mb-2">How this works</h3>
        <div className="flex items-start gap-6 text-xs text-gray-500">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-emerald-400 shrink-0" />
            <span>Both you and your coordinator have confirmed</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-amber-400 shrink-0" />
            <span>One party has confirmed, waiting on the other</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-gray-300 shrink-0" />
            <span>Neither has confirmed yet</span>
          </div>
        </div>
      </div>

      {/* Section Checklist */}
      <div className="space-y-2">
        {SECTIONS.map((section) => {
          const fin = getFinalisation(section.key)
          const status = statusOfSection(fin)

          const statusColor =
            status === 'complete'
              ? 'border-emerald-200 bg-emerald-50/30'
              : status === 'partial'
                ? 'border-amber-200 bg-amber-50/30'
                : 'border-gray-100'

          const statusDot =
            status === 'complete'
              ? 'bg-emerald-400'
              : status === 'partial'
                ? 'bg-amber-400'
                : 'bg-gray-300'

          return (
            <div
              key={section.key}
              className={cn(
                'bg-white rounded-xl border shadow-sm p-4 transition-colors',
                statusColor
              )}
            >
              <div className="flex items-center gap-4">
                {/* Status dot */}
                <div className={cn('w-3 h-3 rounded-full shrink-0', statusDot)} />

                {/* Section info */}
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-gray-800 text-sm">{section.label}</h3>
                  <p className="text-xs text-gray-500">{section.description}</p>
                </div>

                {/* Sign-off columns */}
                <div className="flex items-center gap-3 shrink-0">
                  {/* Couple sign-off */}
                  <div className="text-center">
                    <button
                      onClick={() => toggleCoupleSignOff(section.key)}
                      className={cn(
                        'w-8 h-8 rounded-lg border-2 flex items-center justify-center transition-colors',
                        fin?.couple_signed_off
                          ? 'border-emerald-400 bg-emerald-50'
                          : 'border-gray-200 hover:border-gray-300'
                      )}
                    >
                      {fin?.couple_signed_off ? (
                        <Check className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <span className="w-4 h-4" />
                      )}
                    </button>
                    <p className="text-[9px] text-gray-400 mt-1">You</p>
                  </div>

                  {/* Coordinator sign-off (read-only for couples) */}
                  <div className="text-center">
                    <div
                      className={cn(
                        'w-8 h-8 rounded-lg border-2 flex items-center justify-center',
                        fin?.staff_signed_off
                          ? 'border-emerald-400 bg-emerald-50'
                          : 'border-gray-200 bg-gray-50'
                      )}
                    >
                      {fin?.staff_signed_off ? (
                        <Check className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <Shield className="w-3.5 h-3.5 text-gray-300" />
                      )}
                    </div>
                    <p className="text-[9px] text-gray-400 mt-1">Venue</p>
                  </div>
                </div>
              </div>

              {/* Timestamps */}
              {(fin?.couple_signed_off_at || fin?.staff_signed_off_at) && (
                <div className="flex items-center gap-4 mt-2 ml-7 text-[10px] text-gray-400">
                  {fin?.couple_signed_off_at && (
                    <span>You confirmed {formatDate(fin.couple_signed_off_at)}</span>
                  )}
                  {fin?.staff_signed_off_at && (
                    <span>Venue confirmed {formatDate(fin.staff_signed_off_at)}</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Overall status */}
      {stats.complete === SECTIONS.length && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 text-center">
          <ClipboardCheck className="w-10 h-10 mx-auto mb-3 text-emerald-600" />
          <h3
            className="text-lg font-semibold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)' }}
          >
            Everything is confirmed!
          </h3>
          <p className="text-sm text-emerald-700">
            All sections have been signed off by both you and your coordinator. You are ready.
          </p>
        </div>
      )}
    </div>
  )
}
