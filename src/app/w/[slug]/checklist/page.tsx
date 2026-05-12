'use client'

import { useEffect, useState, Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { CheckSquare, Square, Calendar, AlertTriangle, Heart } from 'lucide-react'

// ---------------------------------------------------------------------------
// /w/[slug]/checklist?t=<share_token>
//
// Read-only checklist surface for partners / family / planners the
// primary couple shares the link with. Tier-A #44 — David problem.
// Token-gated like the rest of the public wedding-website surface.
// No edit / complete / add — just visibility. Couples wanting full
// secondary-user access wait for the magic-link partner invite (Tier
// B item #56).
// ---------------------------------------------------------------------------

interface ChecklistItem {
  id: string
  title: string
  category: string | null
  due_date: string | null
  is_completed: boolean
  description: string | null
  sort_order: number
}

interface ApiResponse {
  couple_names?: string | null
  wedding_date?: string | null
  items?: ChecklistItem[]
  error?: string
}

const CATEGORY_LABEL: Record<string, string> = {
  venue: 'Venue',
  vendors: 'Vendors',
  attire: 'Attire',
  decor: 'Décor',
  legal: 'Legal',
  guests: 'Guests',
  budget: 'Budget',
  other: 'Other',
}

export default function PublicChecklistPage() {
  // Wrap in Suspense — useSearchParams in Next 16 needs a Suspense
  // boundary or it logs a deferred-render warning. Per round-4
  // follow-up F7.
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <p className="text-gray-500 text-sm">Loading checklist…</p>
        </div>
      }
    >
      <PublicChecklistInner />
    </Suspense>
  )
}

function PublicChecklistInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const slug = params.slug as string
  const token = searchParams?.get('t') ?? ''

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [coupleNames, setCoupleNames] = useState<string | null>(null)
  const [weddingDate, setWeddingDate] = useState<string | null>(null)
  const [items, setItems] = useState<ChecklistItem[]>([])

  useEffect(() => {
    async function load() {
      if (!token) {
        setError('This link looks incomplete. Please use the URL the couple sent you.')
        setLoading(false)
        return
      }
      try {
        const res = await fetch(
          `/api/public/wedding-website?slug=${encodeURIComponent(slug)}&t=${encodeURIComponent(token)}&action=checklist`,
        )
        const data = (await res.json()) as ApiResponse
        if (!res.ok) {
          setError(data.error ?? 'Checklist not found')
        } else {
          setCoupleNames(data.couple_names ?? null)
          setWeddingDate(data.wedding_date ?? null)
          setItems(data.items ?? [])
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load checklist')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [slug, token])

  const total = items.length
  const completed = items.filter((i) => i.is_completed).length
  const overdue = items.filter(
    (i) => !i.is_completed && i.due_date && new Date(i.due_date) < new Date(),
  ).length

  // Group by category for the list display.
  const byCategory = items.reduce<Record<string, ChecklistItem[]>>((acc, item) => {
    const cat = item.category ?? 'other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {})

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500 text-sm">Loading checklist…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md text-center">
          <Heart className="w-10 h-10 mx-auto mb-3 text-gray-300" />
          <h1 className="text-xl font-semibold text-gray-700 mb-2">Checklist not available</h1>
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-gray-800 mb-1">
            {coupleNames ? `${coupleNames}'s` : 'Wedding'} Checklist
          </h1>
          {weddingDate && (
            <p className="text-sm text-gray-500">
              <Calendar className="w-4 h-4 inline mr-1" />
              {/* timeZone: 'UTC' — date column parses as UTC midnight; local-tz
                  shifts day back in ET. Sophie trace 2026-05-12. */}
              {new Date(weddingDate).toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                timeZone: 'UTC',
              })}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2 italic">
            Read-only view shared by the couple. Open the couple portal to make changes.
          </p>
        </div>

        {/* Stats */}
        {total > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-white rounded-xl p-4 text-center shadow-sm border border-gray-100">
              <p className="text-2xl font-bold text-gray-800">{total}</p>
              <p className="text-xs text-gray-500 mt-1">Total</p>
            </div>
            <div className="bg-white rounded-xl p-4 text-center shadow-sm border border-gray-100">
              <p className="text-2xl font-bold text-emerald-600">{completed}</p>
              <p className="text-xs text-gray-500 mt-1">Done</p>
            </div>
            <div className="bg-white rounded-xl p-4 text-center shadow-sm border border-gray-100">
              <p className={`text-2xl font-bold ${overdue > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                {overdue}
              </p>
              <p className="text-xs text-gray-500 mt-1">Overdue</p>
            </div>
          </div>
        )}

        {/* Items by category */}
        {total === 0 ? (
          <div className="bg-white rounded-xl p-8 text-center shadow-sm border border-gray-100">
            <p className="text-sm text-gray-500">No tasks yet.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(byCategory).map(([cat, catItems]) => (
              <section key={cat} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 px-4 py-2 bg-gray-50 border-b border-gray-100">
                  {CATEGORY_LABEL[cat] ?? cat}
                </h2>
                <ul className="divide-y divide-gray-100">
                  {catItems.map((item) => {
                    const isOverdue =
                      !item.is_completed && item.due_date && new Date(item.due_date) < new Date()
                    return (
                      <li key={item.id} className="px-4 py-3 flex items-start gap-3">
                        {item.is_completed ? (
                          <CheckSquare className="w-5 h-5 mt-0.5 text-emerald-500 shrink-0" />
                        ) : (
                          <Square className="w-5 h-5 mt-0.5 text-gray-300 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-sm ${item.is_completed ? 'line-through text-gray-400' : 'text-gray-800'}`}
                          >
                            {item.title}
                          </p>
                          {item.description && (
                            <p className="text-xs text-gray-500 mt-1">{item.description}</p>
                          )}
                          {item.due_date && (
                            <p
                              className={`text-xs mt-1 inline-flex items-center gap-1 ${isOverdue ? 'text-amber-600' : 'text-gray-400'}`}
                            >
                              {isOverdue && <AlertTriangle className="w-3 h-3" />}
                              <Calendar className="w-3 h-3" />
                              {/* timeZone: 'UTC' — date column parses as UTC midnight;
                                  local-tz shifts day back in ET. Sophie trace 2026-05-12. */}
                              {new Date(item.due_date).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                timeZone: 'UTC',
                              })}
                            </p>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
