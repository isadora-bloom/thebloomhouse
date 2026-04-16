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
  Save,
  MapPin,
} from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'
import { createBrowserClient } from '@supabase/ssr'
import { VenueChip } from '@/components/intel/venue-chip'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

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
type PageView = 'phrases' | 'reviews'

interface SourceReview {
  id: string
  venue_id: string
  source: string
  reviewer_name: string | null
  rating: number
  title: string | null
  body: string
  review_date: string
  response_text: string | null
  response_date: string | null
  is_featured: boolean
  sentiment_score: number | null
  themes: string[] | null
  created_at: string
  venues?: { name: string | null } | null
}

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
// Source badge helper
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  google: { label: 'Google', color: 'bg-blue-50 text-blue-700' },
  the_knot: { label: 'The Knot', color: 'bg-rose-50 text-rose-700' },
  wedding_wire: { label: 'Wedding Wire', color: 'bg-amber-50 text-amber-700' },
  yelp: { label: 'Yelp', color: 'bg-red-50 text-red-700' },
  facebook: { label: 'Facebook', color: 'bg-indigo-50 text-indigo-700' },
  other: { label: 'Other', color: 'bg-sage-50 text-sage-700' },
}

function SourceBadge({ source }: { source: string }) {
  const info = SOURCE_LABELS[source] ?? SOURCE_LABELS.other
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${info.color}`}>
      {info.label}
    </span>
  )
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`w-4 h-4 ${
            star <= rating ? 'text-amber-400 fill-amber-400' : 'text-sage-200'
          }`}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Source Review Card
// ---------------------------------------------------------------------------

function SourceReviewCard({
  review,
  showVenue,
  onSaveResponse,
}: {
  review: SourceReview
  showVenue: boolean
  onSaveResponse: (id: string, text: string) => Promise<void>
}) {
  const [responseText, setResponseText] = useState(review.response_text ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    await onSaveResponse(review.id, responseText)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      {/* Header: rating + source + date */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <StarRating rating={review.rating} />
        <SourceBadge source={review.source} />
        {review.reviewer_name && (
          <span className="text-sm font-medium text-sage-800">{review.reviewer_name}</span>
        )}
        <span className="text-xs text-sage-500 ml-auto">
          {new Date(review.review_date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </span>
        {showVenue && <VenueChip venueName={review.venues?.name} />}
      </div>

      {/* Title */}
      {review.title && (
        <h3 className="text-sm font-semibold text-sage-900 mb-2">{review.title}</h3>
      )}

      {/* Body */}
      <p className="text-sm text-sage-700 leading-relaxed mb-4 whitespace-pre-line">{review.body}</p>

      {/* Themes */}
      {review.themes && review.themes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {review.themes.map((theme) => {
            const tc = THEME_COLORS[theme] ?? THEME_COLORS.other
            return (
              <span key={theme} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${tc.bg} ${tc.text}`}>
                {formatThemeName(theme)}
              </span>
            )
          })}
        </div>
      )}

      {/* Response textarea */}
      <div className="border-t border-border pt-3 mt-3">
        <label className="block text-xs font-medium text-sage-600 mb-1.5">
          Response {review.response_date ? `(sent ${new Date(review.response_date).toLocaleDateString()})` : '(draft)'}
        </label>
        <textarea
          value={responseText}
          onChange={(e) => { setResponseText(e.target.value); setSaved(false) }}
          placeholder="Draft a response to this review..."
          rows={3}
          className="w-full px-3 py-2 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-warm-white"
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleSave}
            disabled={saving || saved}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save Response'}
          </button>
          {saved && (
            <span className="text-xs text-emerald-600 font-medium">Response saved</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function ReviewAnalysisPage() {
  const scope = useScope()
  const [pageView, setPageView] = useState<PageView>('phrases')
  const [phrases, setPhrases] = useState<ReviewPhrase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FilterTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [approvingId, setApprovingId] = useState<string | null>(null)

  // Source reviews state
  const [sourceReviews, setSourceReviews] = useState<SourceReview[]>([])
  const [reviewsLoading, setReviewsLoading] = useState(false)
  const [reviewsError, setReviewsError] = useState<string | null>(null)
  const [reviewSearch, setReviewSearch] = useState('')

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

  // ---- Fetch source reviews ----
  const fetchSourceReviews = useCallback(async () => {
    setReviewsLoading(true)
    setReviewsError(null)
    try {
      let query = supabase
        .from('reviews')
        .select('*, venues:venue_id(name)')
        .order('review_date', { ascending: false })

      // Scope filtering
      if (scope.level === 'venue' && scope.venueId) {
        query = query.eq('venue_id', scope.venueId)
      } else if (scope.level === 'group' && scope.groupId) {
        const { data: members } = await supabase
          .from('venue_group_members')
          .select('venue_id')
          .eq('group_id', scope.groupId)
        const venueIds = (members ?? []).map((m) => m.venue_id as string)
        if (venueIds.length > 0) {
          query = query.in('venue_id', venueIds)
        }
      } else if (scope.orgId) {
        // company scope — filter to user's org's venues only (prevents cross-org leak)
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        const orgVenueIds = (orgVenues ?? []).map((v) => v.id as string)
        if (orgVenueIds.length > 0) {
          query = query.in('venue_id', orgVenueIds)
        }
      }

      const { data, error: fetchErr } = await query
      if (fetchErr) throw fetchErr
      setSourceReviews((data ?? []) as SourceReview[])
    } catch (err) {
      console.error('Failed to fetch source reviews:', err)
      setReviewsError('Failed to load source reviews')
    } finally {
      setReviewsLoading(false)
    }
  }, [scope.level, scope.venueId, scope.groupId])

  useEffect(() => {
    if (pageView === 'reviews') {
      fetchSourceReviews()
    }
  }, [pageView, fetchSourceReviews])

  // ---- Save review response ----
  const handleSaveResponse = useCallback(async (reviewId: string, responseText: string) => {
    const { error: updateErr } = await supabase
      .from('reviews')
      .update({ response_text: responseText || null, updated_at: new Date().toISOString() })
      .eq('id', reviewId)
    if (updateErr) {
      console.error('Failed to save response:', updateErr)
    } else {
      setSourceReviews((prev) =>
        prev.map((r) => (r.id === reviewId ? { ...r, response_text: responseText || null } : r))
      )
    }
  }, [])

  // ---- Filtered source reviews ----
  const filteredReviews = sourceReviews.filter((r) => {
    if (!reviewSearch.trim()) return true
    const q = reviewSearch.toLowerCase()
    return (
      r.body.toLowerCase().includes(q) ||
      (r.reviewer_name?.toLowerCase().includes(q) ?? false) ||
      (r.title?.toLowerCase().includes(q) ?? false) ||
      r.source.toLowerCase().includes(q)
    )
  })

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
            Reviews
          </h1>
          <p className="text-sage-600">
            {pageView === 'phrases'
              ? 'Extracted themes and sentiment from your reviews across The Knot, WeddingWire, and Google. See what guests love most — these phrases get fed back into your AI\'s voice training.'
              : 'Source reviews from Google, The Knot, and WeddingWire. Draft responses and track sentiment.'}
          </p>
        </div>
        {pageView === 'phrases' && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            Extract from Review
          </button>
        )}
      </div>

      {/* ---- Page view switcher ---- */}
      <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 w-fit">
        <button
          onClick={() => setPageView('phrases')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            pageView === 'phrases'
              ? 'bg-surface text-sage-900 shadow-sm'
              : 'text-sage-600 hover:text-sage-800'
          }`}
        >
          Extracted Phrases
        </button>
        <button
          onClick={() => setPageView('reviews')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            pageView === 'reviews'
              ? 'bg-surface text-sage-900 shadow-sm'
              : 'text-sage-600 hover:text-sage-800'
          }`}
        >
          Source Reviews
          {sourceReviews.length > 0 && (
            <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-sage-100 text-sage-600">
              {sourceReviews.length}
            </span>
          )}
        </button>
      </div>

      {/* ================================================================ */}
      {/* EXTRACTED PHRASES VIEW                                           */}
      {/* ================================================================ */}
      {pageView === 'phrases' && <>

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

      </>}

      {/* ================================================================ */}
      {/* SOURCE REVIEWS VIEW                                              */}
      {/* ================================================================ */}
      {pageView === 'reviews' && (
        <>
          {/* Error state */}
          {reviewsError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
              <ThumbsUp className="w-5 h-5 text-red-500 shrink-0 rotate-180" />
              <p className="text-sm text-red-700">{reviewsError}</p>
              <button
                onClick={() => { setReviewsError(null); fetchSourceReviews() }}
                className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Search */}
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
            <input
              type="text"
              placeholder="Search reviews..."
              value={reviewSearch}
              onChange={(e) => setReviewSearch(e.target.value)}
              className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full bg-warm-white"
            />
          </div>

          {/* Reviews list */}
          {reviewsLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="bg-surface border border-border rounded-xl p-5 shadow-sm animate-pulse">
                  <div className="h-4 w-48 bg-sage-100 rounded mb-3" />
                  <div className="h-3 w-full bg-sage-100 rounded mb-2" />
                  <div className="h-3 w-3/4 bg-sage-100 rounded" />
                </div>
              ))}
            </div>
          ) : filteredReviews.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
              <Quote className="w-12 h-12 text-sage-300 mx-auto mb-4" />
              <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
                {reviewSearch ? 'No matching reviews' : 'No source reviews yet'}
              </h3>
              <p className="text-sm text-sage-600 max-w-md mx-auto">
                {reviewSearch
                  ? `No reviews match "${reviewSearch}".`
                  : 'Import reviews from Google, The Knot, or WeddingWire to see them here.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredReviews.map((review) => (
                <SourceReviewCard
                  key={review.id}
                  review={review}
                  showVenue={scope.level !== 'venue'}
                  onSaveResponse={handleSaveResponse}
                />
              ))}
            </div>
          )}
        </>
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
