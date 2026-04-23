'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  GitMerge,
  X as XIcon,
  Check,
  Mail,
  Phone,
  User,
  AlertCircle,
  Clock,
  HelpCircle,
  Sparkles,
} from 'lucide-react'
import { UpgradeGate } from '@/components/ui/upgrade-gate'
import { useVenueId } from '@/lib/hooks/use-venue-id'

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MatchSignal {
  type: string
  detail: string
  weight: number
}

type MatchTier = 'high' | 'medium' | 'low'

interface MatchQueueItem {
  id: string
  person_a_id: string
  person_b_id: string
  match_type: string
  confidence: number
  status: string
  created_at: string
  signals: MatchSignal[] | null
  tier: MatchTier | null
}

interface PersonRow {
  id: string
  first_name: string
  last_name: string
  wedding_id: string
}

interface ContactRow {
  id: string
  person_id: string
  type: string
  value: string
}

interface TangentialSignalRow {
  id: string
  signal_type: string
  source_context: string | null
  signal_date: string | null
  matched_person_id: string | null
}

interface MatchPair {
  queueItem: MatchQueueItem
  personA: { name: string; emails: string[]; phones: string[] }
  personB: { name: string; emails: string[]; phones: string[] }
  tangentialCount: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchTypeBadge(type: string): string {
  switch (type) {
    case 'email':
      return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'phone':
      return 'bg-teal-50 text-teal-700 border-teal-200'
    case 'name':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    default:
      return 'bg-sage-50 text-sage-700 border-sage-200'
  }
}

function matchTypeIcon(type: string) {
  switch (type) {
    case 'email':
      return Mail
    case 'phone':
      return Phone
    default:
      return User
  }
}

function confidenceColor(c: number): string {
  if (c >= 0.9) return 'text-emerald-700 bg-emerald-50'
  if (c >= 0.7) return 'text-amber-700 bg-amber-50'
  return 'text-sage-700 bg-sage-50'
}

function tierStyle(tier: MatchTier | null): { classes: string; label: string } {
  switch (tier) {
    case 'high':
      return {
        classes: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        label: 'High confidence',
      }
    case 'low':
      return {
        classes: 'bg-sage-50 text-sage-600 border-sage-200',
        label: 'Loose',
      }
    case 'medium':
    default:
      return {
        classes: 'bg-amber-50 text-amber-700 border-amber-200',
        label: 'Suggested',
      }
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function MatchCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-5 w-16 bg-sage-100 rounded-full" />
          <div className="h-5 w-24 bg-sage-100 rounded" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="h-16 bg-sage-50 rounded-lg" />
          <div className="h-16 bg-sage-50 rounded-lg" />
        </div>
        <div className="flex gap-2">
          <div className="h-8 w-20 bg-sage-100 rounded" />
          <div className="h-8 w-20 bg-sage-100 rounded" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function MatchingPageInner() {
  const VENUE_ID = useVenueId()
  const [queue, setQueue] = useState<MatchQueueItem[]>([])
  const [people, setPeople] = useState<PersonRow[]>([])
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [tangentialByPerson, setTangentialByPerson] = useState<
    Map<string, TangentialSignalRow[]>
  >(new Map())
  const [aiName, setAiName] = useState<string>('Sage')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState<string | null>(null)
  const [showSnoozed, setShowSnoozed] = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const [queueRes, peopleRes, contactRes, aiRes] = await Promise.all([
        supabase
          .from('client_match_queue')
          .select(
            'id, person_a_id, person_b_id, match_type, confidence, status, created_at, signals, tier'
          )
          .in('status', ['pending', 'snoozed'])
          .order('confidence', { ascending: false }),
        supabase.from('people').select('id, first_name, last_name, wedding_id'),
        supabase.from('contacts').select('id, person_id, type, value'),
        supabase
          .from('venue_ai_config')
          .select('ai_name')
          .eq('venue_id', VENUE_ID)
          .maybeSingle(),
      ])
      if (queueRes.error) throw queueRes.error
      if (peopleRes.error) throw peopleRes.error
      if (contactRes.error) throw contactRes.error

      const queueRows = (queueRes.data ?? []) as MatchQueueItem[]
      const personIds = new Set<string>()
      for (const q of queueRows) {
        if (q.person_a_id) personIds.add(q.person_a_id)
        if (q.person_b_id) personIds.add(q.person_b_id)
      }

      // Fetch tangential signals linked to any person in the queue
      let tangentialMap = new Map<string, TangentialSignalRow[]>()
      if (personIds.size > 0) {
        const { data: signalsData, error: signalsErr } = await supabase
          .from('tangential_signals')
          .select('id, signal_type, source_context, signal_date, matched_person_id')
          .in('matched_person_id', Array.from(personIds))
        if (!signalsErr && signalsData) {
          for (const s of signalsData as TangentialSignalRow[]) {
            if (!s.matched_person_id) continue
            const list = tangentialMap.get(s.matched_person_id) ?? []
            list.push(s)
            tangentialMap.set(s.matched_person_id, list)
          }
        }
      }

      setQueue(queueRows)
      setPeople((peopleRes.data ?? []) as PersonRow[])
      setContacts((contactRes.data ?? []) as ContactRow[])
      setTangentialByPerson(tangentialMap)
      if (aiRes.data?.ai_name) setAiName(aiRes.data.ai_name as string)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch match data:', err)
      setError('Failed to load match queue')
    } finally {
      setLoading(false)
    }
  }, [VENUE_ID])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Build match pairs
  const pairs: MatchPair[] = useMemo(() => {
    const personMap = new Map(people.map((p) => [p.id, p]))
    const contactsByPerson = new Map<string, ContactRow[]>()
    for (const c of contacts) {
      const list = contactsByPerson.get(c.person_id) ?? []
      list.push(c)
      contactsByPerson.set(c.person_id, list)
    }

    return queue.map((q) => {
      const pA = personMap.get(q.person_a_id)
      const pB = personMap.get(q.person_b_id)
      const cA = contactsByPerson.get(q.person_a_id) ?? []
      const cB = contactsByPerson.get(q.person_b_id) ?? []

      const nameA = pA
        ? [pA.first_name, pA.last_name].filter(Boolean).join(' ').trim()
        : ''
      const nameB = pB
        ? [pB.first_name, pB.last_name].filter(Boolean).join(' ').trim()
        : ''
      const emailsA = cA.filter((c) => c.type === 'email').map((c) => c.value)
      const emailsB = cB.filter((c) => c.type === 'email').map((c) => c.value)

      const tangentialA = tangentialByPerson.get(q.person_a_id) ?? []
      const tangentialB = tangentialByPerson.get(q.person_b_id) ?? []
      const tangentialCount = tangentialA.length + tangentialB.length

      return {
        queueItem: q,
        personA: {
          name: nameA || emailsA[0] || 'No name on record',
          emails: emailsA,
          phones: cA.filter((c) => c.type === 'phone').map((c) => c.value),
        },
        personB: {
          name: nameB || emailsB[0] || 'No name on record',
          emails: emailsB,
          phones: cB.filter((c) => c.type === 'phone').map((c) => c.value),
        },
        tangentialCount,
      }
    })
  }, [queue, people, contacts, tangentialByPerson])

  // Stats
  const pendingCount = queue.filter((q) => q.status === 'pending').length
  const snoozedCount = queue.filter((q) => q.status === 'snoozed').length
  const mergedThisMonth = 0 // Would query historical merged records

  // Filter pairs by current tab (pending vs snoozed)
  const visiblePairs = pairs.filter((p) =>
    showSnoozed ? p.queueItem.status === 'snoozed' : p.queueItem.status === 'pending'
  )

  // ----- Actions: all go through the Phase 8 resolve endpoint ---------------

  const callResolve = useCallback(
    async (
      id: string,
      action: 'merge' | 'dismiss' | 'snooze' | 'unsnooze' | 'wait_for_signal'
    ): Promise<boolean> => {
      const res = await fetch(`/api/agent/match-queue/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.error(`Resolve ${action} failed:`, res.status, text)
        setError(`Could not ${action.replace('_', ' ')} this match. Try again.`)
        return false
      }
      setError(null)
      return true
    },
    []
  )

  const handleMerge = async (id: string) => {
    setProcessing(id)
    try {
      const ok = await callResolve(id, 'merge')
      if (ok) setQueue((prev) => prev.filter((q) => q.id !== id))
    } finally {
      setProcessing(null)
    }
  }

  const handleDismiss = async (id: string) => {
    setProcessing(id)
    try {
      const ok = await callResolve(id, 'dismiss')
      if (ok) setQueue((prev) => prev.filter((q) => q.id !== id))
    } finally {
      setProcessing(null)
    }
  }

  const handleSnooze = async (id: string) => {
    setProcessing(id)
    try {
      const ok = await callResolve(id, 'snooze')
      if (ok) {
        setQueue((prev) =>
          prev.map((q) => (q.id === id ? { ...q, status: 'snoozed' } : q))
        )
      }
    } finally {
      setProcessing(null)
    }
  }

  const handleUnsnooze = async (id: string) => {
    setProcessing(id)
    try {
      const ok = await callResolve(id, 'unsnooze')
      if (ok) {
        setQueue((prev) =>
          prev.map((q) => (q.id === id ? { ...q, status: 'pending' } : q))
        )
      }
    } finally {
      setProcessing(null)
    }
  }

  const handleWaitForSignal = async (id: string) => {
    setProcessing(id)
    try {
      const ok = await callResolve(id, 'wait_for_signal')
      if (ok) {
        setQueue((prev) =>
          prev.map((q) => (q.id === id ? { ...q, status: 'snoozed' } : q))
        )
      }
    } finally {
      setProcessing(null)
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Client Deduplication
        </h1>
        <p className="text-sage-600">
          Find and resolve duplicate records. {aiName} flags couples who inquired from multiple sources or with slightly different names. Merge duplicates to keep your pipeline clean and your data accurate.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
        <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <p className="text-sm font-medium text-sage-600 mb-1">Pending Matches</p>
          <p className="text-2xl font-bold text-sage-900">{pendingCount}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <p className="text-sm font-medium text-sage-600 mb-1">Snoozed</p>
          <p className="text-2xl font-bold text-sage-900">{snoozedCount}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <p className="text-sm font-medium text-sage-600 mb-1">Merged This Month</p>
          <p className="text-2xl font-bold text-sage-900">{mergedThisMonth}</p>
        </div>
      </div>

      {/* Queue filter tabs */}
      {!loading && (pendingCount > 0 || snoozedCount > 0) && (
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 w-fit">
          <button
            onClick={() => setShowSnoozed(false)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              !showSnoozed
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            Pending ({pendingCount})
          </button>
          <button
            onClick={() => setShowSnoozed(true)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              showSnoozed
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            Snoozed ({snoozedCount})
          </button>
        </div>
      )}

      {/* Match queue */}
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <MatchCardSkeleton key={i} />
          ))}
        </div>
      ) : visiblePairs.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <GitMerge className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {showSnoozed ? 'No snoozed matches' : 'No pending matches'}
          </h3>
          <p className="text-sm text-sage-600">
            {showSnoozed
              ? 'Pairs marked "Review later" will appear here.'
              : 'Potential duplicates will appear here when detected.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {visiblePairs.map((pair) => {
            const q = pair.queueItem
            const TypeIcon = matchTypeIcon(q.match_type)
            const isProcessing = processing === q.id
            const isSnoozed = q.status === 'snoozed'
            const tier = q.tier ?? 'medium'
            const tierInfo = tierStyle(tier)
            const signals = Array.isArray(q.signals) ? q.signals : []
            return (
              <div
                key={q.id}
                className={`bg-surface border border-border rounded-xl p-6 shadow-sm transition-opacity ${
                  isSnoozed ? 'opacity-60' : ''
                }`}
              >
                {/* Auto-merged ribbon for high-tier */}
                {tier === 'high' && !isSnoozed && (
                  <div className="flex items-center gap-1.5 mb-3 text-xs text-emerald-700">
                    <Sparkles className="w-3 h-3" />
                    <span className="font-medium uppercase tracking-wider">
                      Auto-merge candidate
                    </span>
                  </div>
                )}
                {isSnoozed && (
                  <div className="flex items-center gap-1.5 mb-3 text-xs text-sage-500">
                    <Clock className="w-3 h-3" />
                    <span className="font-medium uppercase tracking-wider">
                      Snoozed. Review later.
                    </span>
                  </div>
                )}
                {/* Match info */}
                <div className="flex items-center gap-2 mb-4 flex-wrap">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${matchTypeBadge(q.match_type)}`}
                  >
                    <TypeIcon className="w-2.5 h-2.5" />
                    {q.match_type} match
                  </span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${tierInfo.classes}`}
                  >
                    {tierInfo.label}
                  </span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${confidenceColor(q.confidence)}`}
                  >
                    {(q.confidence * 100).toFixed(0)}% confidence
                  </span>
                  {pair.tangentialCount > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-sage-700 bg-sage-50 border border-sage-200">
                      <Sparkles className="w-3 h-3" />
                      {pair.tangentialCount} prior touchpoint
                      {pair.tangentialCount === 1 ? '' : 's'} before this inquiry
                    </span>
                  )}
                </div>

                {/* Side-by-side comparison */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  {[pair.personA, pair.personB].map((person, idx) => (
                    <div
                      key={idx}
                      className="bg-warm-white border border-sage-100 rounded-lg p-4"
                    >
                      <p className="font-heading text-sm font-semibold text-sage-900 mb-2">
                        {person.name}
                      </p>
                      <div className="space-y-1 text-xs text-sage-600">
                        {person.emails.map((e) => (
                          <p key={e} className="flex items-center gap-1.5">
                            <Mail className="w-3 h-3 text-sage-400" /> {e}
                          </p>
                        ))}
                        {person.phones.map((p) => (
                          <p key={p} className="flex items-center gap-1.5">
                            <Phone className="w-3 h-3 text-sage-400" /> {p}
                          </p>
                        ))}
                        {person.emails.length === 0 && person.phones.length === 0 && (
                          <p className="text-sage-400">No contact info</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Signals: why Bloom thinks these match */}
                {signals.length > 0 && (
                  <div className="mb-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-sage-500 mb-2">
                      Why {aiName} suggested this match
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {signals.map((s, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-sage-700 bg-sage-50 border border-sage-100"
                          title={`${s.type} · weight ${s.weight?.toFixed?.(2) ?? s.weight}`}
                        >
                          {s.detail}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => handleMerge(q.id)}
                    disabled={isProcessing}
                    className="flex items-center gap-1.5 px-4 py-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Merge
                  </button>
                  <button
                    onClick={() => handleDismiss(q.id)}
                    disabled={isProcessing}
                    className="flex items-center gap-1.5 px-4 py-2 border border-sage-200 text-sage-600 hover:bg-sage-50 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                    Dismiss
                  </button>
                  {!isSnoozed && (
                    <button
                      onClick={() => handleWaitForSignal(q.id)}
                      disabled={isProcessing}
                      className="flex items-center gap-1.5 px-4 py-2 border border-sage-200 text-sage-600 hover:bg-sage-50 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                      title="Hold this pair until a stronger signal arrives"
                    >
                      <HelpCircle className="w-3.5 h-3.5" />
                      Wait for more signal
                    </button>
                  )}
                  {isSnoozed ? (
                    <button
                      onClick={() => handleUnsnooze(q.id)}
                      disabled={isProcessing}
                      className="flex items-center gap-1.5 px-4 py-2 border border-sage-200 text-sage-600 hover:bg-sage-50 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Clock className="w-3.5 h-3.5" />
                      Move back to Pending
                    </button>
                  ) : (
                    <button
                      onClick={() => handleSnooze(q.id)}
                      disabled={isProcessing}
                      className="flex items-center gap-1.5 px-4 py-2 border border-sage-200 text-sage-600 hover:bg-sage-50 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Clock className="w-3.5 h-3.5" />
                      Review later
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function MatchingPageWrapper() {
  return (
    <UpgradeGate requiredTier="enterprise" featureName="Client Deduplication">
      <MatchingPageInner />
    </UpgradeGate>
  )
}
