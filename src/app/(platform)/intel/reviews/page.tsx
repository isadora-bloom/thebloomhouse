'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Quote,
  Star,
  CheckCircle,
  Search,
  Plus,
  X,
  ThumbsUp,
  MessageSquare,
  Sparkles,
  Megaphone,
} from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'
import { VenueChip } from '@/components/intel/venue-chip'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewPhrase {
  id: string
  venue_id: string
  phrase: string
  theme: string
  sentiment_score: number
  frequency: number
  approved_for_sage: boolean
  approved_for_marketing: boolean
  created_at: string
  venues?: { name: string | null } | null
}

type FilterTab = 'all' | 'sage' | 'marketing'

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const THEME_COLORS: Record<string, { bg: string; text: string }> = {
  coordinator:    { bg: 'bg-purple-50',  text: 'text-purple-700' },
  space:          { bg: 'bg-teal-50',    text: 'text-teal-700' },
  flexibility:    { bg: 'bg-indigo-50',  text: 'text-indigo-700' },
  value:          { bg: 'bg-emerald-50', text: 'text-emerald-700' },
  experience:     { bg: 'bg-rose-50',    text: 'text-rose-700' },
  process:        { bg: 'bg-sky-50',     text: 'text-sky-700' },
  pets:           { bg: 'bg-amber-50',   text: 'text-amber-700' },
  exclusivity:    { bg: 'bg-violet-50',  text: 'text-violet-700' },
  food_catering:  { bg: 'bg-orange-50',  text: 'text-orange-700' },
  accommodation:  { bg: 'bg-cyan-50',    text: 'text-cyan-700' },
  ceremony:       { bg: 'bg-pink-50',    text: 'text-pink-700' },
  other:          { bg: 'bg-sage-50',    text: 'text-sage-700' },
}

function getThemeColor(theme: string) {
  return THEME_COLORS[theme] ?? THEME_COLORS.other
}

function formatThemeName(theme: string): string {
  return theme
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Sentiment Bar
// ---------------------------------------------------------------------------

function SentimentBar({ value }: { value: number }) {
  // value ranges from -1 to 1, map to 0-100%
  const percent = ((value + 1) / 2) * 100
  const isPositive = value >= 0
  const isNeutral = Math.abs(value) < 0.15

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-sage-100 rounded-full overflow-hidden relative">
        {/* Center line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-sage-300 z-10" />
        {/* Fill bar */}
        {isPositive ? (
          <div
            className="absolute top-0 bottom-0 bg-emerald-400 rounded-full"
            style={{ left: '50%', width: `${(value / 1) * 50}%` }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 bg-red-400 rounded-full"
            style={{ right: '50%', width: `${(Math.abs(value) / 1) * 50}%` }}
          />
        )}
      </div>
      <span className={`text-xs font-medium tabular-nums w-10 text-right ${
        isNeutral ? 'text-sage-500' : isPositive ? 'text-emerald-600' : 'text-red-600'
      }`}>
        {value > 0 ? '+' : ''}{value.toFixed(2)}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skeleton components
// ---------------------------------------------------------------------------

function PhraseCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-5 w-3/4 bg-sage-100 rounded" />
        <div className="flex gap-2">
          <div className="h-5 w-20 bg-sage-100 rounded-full" />
          <div className="h-5 w-12 bg-sage-100 rounded-full" />
        </div>
        <div className="h-1.5 w-full bg-sage-100 rounded-full" />
        <div className="flex gap-2">
          <div className="h-8 w-28 bg-sage-50 rounded-lg" />
          <div className="h-8 w-36 bg-sage-50 rounded-lg" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Extract Modal
// ---------------------------------------------------------------------------

function ExtractModal({
  onClose,
  onExtract,
}: {
  onClose: () => void
  onExtract: (text: string, rating?: number) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [rating, setRating] = useState<number | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!text.trim()) return
    setExtracting(true)
    setError(null)
    try {
      await onExtract(text.trim(), rating ?? undefined)
      onClose()
    } catch (err) {
      setError('Failed to extract phrases. Please try again.')
    } finally {
      setExtracting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Modal */}
      <div className="relative bg-surface rounded-2xl shadow-2xl w-full max-w-lg border border-border">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <Quote className="w-5 h-5 text-sage-600" />
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Extract from Review
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pb-6 space-y-4">
          {/* Review text */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1.5">
              Review Text
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the full review text here..."
              rows={6}
              className="w-full px-3 py-2.5 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-warm-white"
            />
          </div>

          {/* Star rating */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1.5">
              Rating <span className="text-sage-400 font-normal">(optional)</span>
            </label>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setRating(rating === star ? null : star)}
                  className="p-1 transition-colors"
                >
                  <Star
                    className={`w-6 h-6 ${
                      rating && star <= rating
                        ? 'text-amber-400 fill-amber-400'
                        : 'text-sage-200'
                    }`}
                  />
                </button>
              ))}
              {rating && (
                <span className="ml-2 text-sm text-sage-500">{rating}/5</span>
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-700 border border-sage-300 rounded-lg hover:bg-sage-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!text.trim() || extracting}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Sparkles className={`w-4 h-4 ${extracting ? 'animate-pulse' : ''}`} />
              {extracting ? 'Extracting...' : 'Extract Phrases'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phrase Card
// ---------------------------------------------------------------------------

function PhraseCard({
  phrase,
  onApprove,
  approvingId,
  showVenue,
}: {
  phrase: ReviewPhrase
  onApprove: (id: string, context: 'sage' | 'marketing') => void
  approvingId: string | null
  showVenue: boolean
}) {
  const themeColor = getThemeColor(phrase.theme)

  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
      {/* Phrase text */}
      <div className="flex items-start gap-2 mb-3">
        <Quote className="w-4 h-4 text-sage-300 mt-0.5 shrink-0" />
        <p className="text-sage-900 font-medium leading-relaxed italic">
          &ldquo;{phrase.phrase}&rdquo;
        </p>
      </div>

      {/* Meta row: theme + frequency */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${themeColor.bg} ${themeColor.text}`}>
          {formatThemeName(phrase.theme)}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-sage-500">
          <MessageSquare className="w-3 h-3" />
          {phrase.frequency}x mentioned
        </span>
        {showVenue && <VenueChip venueName={phrase.venues?.name} />}
      </div>

      {/* Sentiment bar */}
      <div className="mb-4">
        <SentimentBar value={phrase.sentiment_score} />
      </div>

      {/* Approval buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onApprove(phrase.id, 'sage')}
          disabled={phrase.approved_for_sage || approvingId === `${phrase.id}-sage`}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            phrase.approved_for_sage
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-default'
              : approvingId === `${phrase.id}-sage`
                ? 'bg-sage-100 text-sage-400 border border-sage-200 cursor-not-allowed'
                : 'border border-sage-300 text-sage-700 hover:bg-sage-50'
          }`}
        >
          {phrase.approved_for_sage ? (
            <CheckCircle className="w-3.5 h-3.5" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          {phrase.approved_for_sage ? 'Sage Approved' : 'Approve for Sage'}
        </button>

        <button
          onClick={() => onApprove(phrase.id, 'marketing')}
          disabled={phrase.approved_for_marketing || approvingId === `${phrase.id}-marketing`}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            phrase.approved_for_marketing
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-default'
              : approvingId === `${phrase.id}-marketing`
                ? 'bg-sage-100 text-sage-400 border border-sage-200 cursor-not-allowed'
                : 'border border-sage-300 text-sage-700 hover:bg-sage-50'
          }`}
        >
          {phrase.approved_for_marketing ? (
            <CheckCircle className="w-3.5 h-3.5" />
          ) : (
            <Megaphone className="w-3.5 h-3.5" />
          )}
          {phrase.approved_for_marketing ? 'Marketing Approved' : 'Approve for Marketing'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function ReviewAnalysisPage() {
  const scope = useScope()
  const [phrases, setPhrases] = useState<ReviewPhrase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FilterTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [approvingId, setApprovingId] = useState<string | null>(null)

  // ---- Fetch phrases ----
  const fetchPhrases = useCallback(async () => {
    try {
      let url = '/api/intel/reviews'
      if (activeTab === 'sage') url += '?approved=sage'
      else if (activeTab === 'marketing') url += '?approved=marketing'

      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to fetch phrases')
      const data = await res.json()

      // The sage/marketing endpoints return grouped data, flatten if needed
      if (activeTab !== 'all' && data.phrases && !Array.isArray(data.phrases)) {
        const flat: ReviewPhrase[] = []
        for (const theme of Object.keys(data.phrases)) {
          flat.push(...data.phrases[theme])
        }
        setPhrases(flat)
      } else {
        setPhrases(data.phrases ?? [])
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch review phrases:', err)
      setError('Failed to load review phrases')
    } finally {
      setLoading(false)
    }
  }, [activeTab])

  useEffect(() => {
    setLoading(true)
    fetchPhrases()
  }, [fetchPhrases])

  // ---- Extract from review ----
  const handleExtract = async (text: string, rating?: number) => {
    const res = await fetch('/api/intel/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, rating }),
    })
    if (!res.ok) throw new Error('Extraction failed')
    // Refresh phrases after extraction
    await fetchPhrases()
  }

  // ---- Approve phrase ----
  const handleApprove = async (phraseId: string, context: 'sage' | 'marketing') => {
    const trackingId = `${phraseId}-${context}`
    setApprovingId(trackingId)
    try {
      const res = await fetch('/api/intel/reviews', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phraseId, context }),
      })
      if (!res.ok) throw new Error('Failed to approve phrase')

      // Update local state
      setPhrases((prev) =>
        prev.map((p) => {
          if (p.id !== phraseId) return p
          return {
            ...p,
            ...(context === 'sage' ? { approved_for_sage: true } : {}),
            ...(context === 'marketing' ? { approved_for_marketing: true } : {}),
          }
        })
      )
    } catch (err) {
      console.error('Failed to approve phrase:', err)
    } finally {
      setApprovingId(null)
    }
  }

  // ---- Filtered + searched phrases ----
  const filteredPhrases = phrases.filter((p) => {
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase()
    return (
      p.phrase.toLowerCase().includes(query) ||
      p.theme.toLowerCase().includes(query)
    )
  })

  // ---- Stats ----
  const totalCount = phrases.length
  const sageCount = phrases.filter((p) => p.approved_for_sage).length
  const marketingCount = phrases.filter((p) => p.approved_for_marketing).length

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: totalCount },
    { key: 'sage', label: 'Approved for Sage', count: sageCount },
    { key: 'marketing', label: 'Approved for Marketing', count: marketingCount },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Review Language
          </h1>
          <p className="text-sage-600">
            Extracted themes and sentiment from your reviews across The Knot, WeddingWire, and Google. See what guests love most — these phrases get fed back into your AI's voice training.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Extract from Review
        </button>
      </div>

      {/* ---- Error state ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <ThumbsUp className="w-5 h-5 text-red-500 shrink-0 rotate-180" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchPhrases() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Filter tabs + search ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Tabs */}
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                activeTab === tab.key
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {tab.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeTab === tab.key
                  ? 'bg-sage-100 text-sage-700'
                  : 'bg-sage-100/50 text-sage-500'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search phrases or themes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Phrases grid ---- */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(6)].map((_, i) => (
            <PhraseCardSkeleton key={i} />
          ))}
        </div>
      ) : filteredPhrases.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Quote className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {searchQuery
              ? 'No matching phrases'
              : activeTab !== 'all'
                ? 'No approved phrases yet'
                : 'No phrases extracted yet'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {searchQuery
              ? `No phrases match "${searchQuery}". Try a different search term.`
              : activeTab !== 'all'
                ? 'Review phrases and approve them to build your Sage vocabulary and marketing library.'
                : 'Paste a guest review to extract memorable, quotable language using AI.'}
          </p>
          {!searchQuery && activeTab === 'all' && (
            <button
              onClick={() => setShowModal(true)}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              Extract from Review
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredPhrases.map((phrase) => (
            <PhraseCard
              key={phrase.id}
              phrase={phrase}
              onApprove={handleApprove}
              approvingId={approvingId}
              showVenue={scope.level !== 'venue'}
            />
          ))}
        </div>
      )}

      {/* ---- Extract Modal ---- */}
      {showModal && (
        <ExtractModal
          onClose={() => setShowModal(false)}
          onExtract={handleExtract}
        />
      )}
    </div>
  )
}
