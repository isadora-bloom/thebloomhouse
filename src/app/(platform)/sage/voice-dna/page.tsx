'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Sparkles,
  Flame,
  Feather,
  Smile,
  Scissors,
  Zap,
  Quote,
  ClipboardCheck,
  Copy,
  ArrowRightLeft,
  Megaphone,
  AlertCircle,
  Mic,
  GraduationCap,
  Mail,
  Loader2,
  Check as CheckIcon,
} from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'

// ---------------------------------------------------------------------------
// Phase 5 Tasks 48, 49, 51 — Voice DNA
//
// A single hero page that shows everything the AI has learned about the
// venue's voice: tone dimensions, approved review phrases, edit patterns,
// marketing copy candidates, and a learning timeline. Venue-scoped only;
// at group/company scope we bounce the user to the scope selector because
// voice DNA is fundamentally per-venue.
// ---------------------------------------------------------------------------

interface PhraseRow {
  phrase: string
  sentiment_score: number | null
  frequency: number
  usageCount: number
  sourceType?: 'review' | 'transcript' | 'manual'
}

interface VoiceDnaData {
  aiName: string
  venueName: string
  daysLearning: number
  sampleCount: number
  trainingSessionCount: number
  /** T5-followup-Z: outbound interactions seen by Sage. */
  emailsSeen: number
  /** T5-followup-Z: next milestone in the learning ladder. null = mature. */
  nextMilestone: {
    label: string
    progress: number
    detail: string
  } | null
  dimensions: {
    warmth: number
    formality: number
    playfulness: number
    brevity: number
    enthusiasm: number
  }
  phrasesByTheme: Record<string, PhraseRow[]>
  marketingByTheme: Record<string, PhraseRow[]>
  editPairs: Array<{ banned: string; approved: string }>
  timeline: Array<{ week: string; trainings: number; preferences: number }>
  /** T5-followup-EE (#94): Stream X's monthly refresh visibility. */
  refresh: {
    lastRefreshedAt: string | null
    daysSinceLastRefresh: number | null
    newPhrasesLastRefresh: number | null
    nextRefreshAt: string
  }
}

// ---------------------------------------------------------------------------
// Dimension labels (threshold-based, no venue-specific hardcoding)
// ---------------------------------------------------------------------------

const DIMENSION_CONFIG: Array<{
  key: keyof VoiceDnaData['dimensions']
  title: string
  icon: React.ComponentType<{ className?: string }>
  lowLabel: string
  midLabel: string
  highLabel: string
}> = [
  { key: 'warmth',      title: 'Warmth',      icon: Flame,    lowLabel: 'Reserved',  midLabel: 'Friendly',     highLabel: 'Warm' },
  { key: 'formality',   title: 'Formality',   icon: Feather,  lowLabel: 'Casual',    midLabel: 'Conversational', highLabel: 'Formal' },
  { key: 'playfulness', title: 'Playfulness', icon: Smile,    lowLabel: 'Serious',   midLabel: 'Balanced',     highLabel: 'Playful' },
  { key: 'brevity',     title: 'Brevity',     icon: Scissors, lowLabel: 'Elaborate', midLabel: 'Balanced',     highLabel: 'Concise' },
  { key: 'enthusiasm',  title: 'Enthusiasm',  icon: Zap,      lowLabel: 'Composed',  midLabel: 'Grounded',     highLabel: 'Excited' },
]

function dimensionLabel(score: number, low: string, mid: string, high: string): string {
  if (score >= 8) return high
  if (score <= 3) return low
  return mid
}

// ---------------------------------------------------------------------------
// Theme names
// ---------------------------------------------------------------------------

function formatThemeName(theme: string): string {
  return theme
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

const THEME_COLORS: Record<string, string> = {
  coordinator:    'bg-purple-50 text-purple-700 border-purple-200',
  space:          'bg-teal-50 text-teal-700 border-teal-200',
  flexibility:    'bg-indigo-50 text-indigo-700 border-indigo-200',
  value:          'bg-emerald-50 text-emerald-700 border-emerald-200',
  experience:     'bg-rose-50 text-rose-700 border-rose-200',
  process:        'bg-sky-50 text-sky-700 border-sky-200',
  pets:           'bg-amber-50 text-amber-700 border-amber-200',
  exclusivity:    'bg-violet-50 text-violet-700 border-violet-200',
  food_catering:  'bg-orange-50 text-orange-700 border-orange-200',
  accommodation:  'bg-cyan-50 text-cyan-700 border-cyan-200',
  ceremony:       'bg-pink-50 text-pink-700 border-pink-200',
  other:          'bg-sage-50 text-sage-700 border-sage-200',
}

function themeChipClass(theme: string): string {
  return THEME_COLORS[theme] ?? THEME_COLORS.other
}

// ---------------------------------------------------------------------------
// Sentiment bar (compact version, matches /intel/reviews style)
// ---------------------------------------------------------------------------

function SentimentBar({ value }: { value: number | null }) {
  if (value == null) {
    return <span className="text-xs text-sage-400">--</span>
  }
  const isPositive = value >= 0
  const width = Math.min(Math.abs(value), 1) * 50

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-sage-100 rounded-full overflow-hidden relative min-w-[60px]">
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-sage-300 z-10" />
        {isPositive ? (
          <div className="absolute top-0 bottom-0 bg-emerald-400 rounded-full" style={{ left: '50%', width: `${width}%` }} />
        ) : (
          <div className="absolute top-0 bottom-0 bg-red-400 rounded-full" style={{ right: '50%', width: `${width}%` }} />
        )}
      </div>
      <span className={`text-[10px] font-medium tabular-nums w-9 text-right ${
        isPositive ? 'text-emerald-600' : 'text-red-600'
      }`}>
        {value > 0 ? '+' : ''}{value.toFixed(2)}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      <div className="animate-pulse">
        <div className="h-10 w-2/3 bg-sage-100 rounded mb-3" />
        <div className="h-4 w-1/2 bg-sage-100 rounded" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-5 shadow-sm animate-pulse">
            <div className="h-4 w-24 bg-sage-100 rounded mb-3" />
            <div className="h-8 w-12 bg-sage-100 rounded mb-2" />
            <div className="h-2 w-full bg-sage-100 rounded" />
          </div>
        ))}
      </div>
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm animate-pulse">
        <div className="h-6 w-48 bg-sage-100 rounded mb-4" />
        <div className="space-y-2">
          <div className="h-4 w-full bg-sage-100 rounded" />
          <div className="h-4 w-3/4 bg-sage-100 rounded" />
          <div className="h-4 w-5/6 bg-sage-100 rounded" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Copyable marketing quote
// ---------------------------------------------------------------------------

function MarketingQuote({ phrase }: { phrase: string }) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(phrase).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }).catch(() => { /* ignore clipboard failures */ })
    }
  }, [phrase])

  return (
    <div className="group flex items-start gap-3 bg-warm-white border border-border rounded-lg p-3 hover:border-sage-300 transition-colors">
      <Quote className="w-4 h-4 text-sage-300 mt-0.5 shrink-0" />
      <p className="flex-1 text-sm italic text-sage-800 leading-relaxed">
        &ldquo;{phrase}&rdquo;
      </p>
      <button
        onClick={copy}
        className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors ${
          copied
            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            : 'bg-surface border border-sage-200 text-sage-600 hover:text-sage-900 hover:bg-sage-50 opacity-0 group-hover:opacity-100'
        }`}
      >
        {copied ? <ClipboardCheck className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function VoiceDnaPage() {
  const scope = useScope()

  const [data, setData] = useState<VoiceDnaData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTheme, setActiveTheme] = useState<string | null>(null)

  // B6 (2026-05-08): Gmail history backfill state.
  const [backfilling, setBackfilling] = useState(false)
  const [backfillResult, setBackfillResult] = useState<{ scanned: number; phrases_inserted: number; phrases_deduped: number; errors: string[] } | null>(null)
  const [backfillError, setBackfillError] = useState<string | null>(null)

  const isVenueScope = scope.level === 'venue'

  const fetchData = useCallback(async () => {
    if (scope.loading) return
    if (!isVenueScope) {
      setLoading(false)
      return
    }
    if (!scope.venueId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ venueId: scope.venueId })
      const res = await fetch(`/api/intel/voice-dna?${qs.toString()}`, {
        credentials: 'include',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message || body?.error || 'Failed to load voice DNA')
      }
      const json = (await res.json()) as VoiceDnaData
      setData(json)
      // Default to the first theme with approved phrases.
      const firstTheme = Object.keys(json.phrasesByTheme)[0] ?? null
      setActiveTheme(firstTheme)
    } catch (err) {
      console.error('Voice DNA fetch failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to load voice DNA')
    } finally {
      setLoading(false)
    }
  }, [scope.loading, scope.venueId, isVenueScope])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ----- Cross-venue scope empty state -----------------------------------
  if (!scope.loading && !isVenueScope) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <Sparkles className="w-7 h-7 text-sage-500" />
            Voice DNA
          </h1>
          <p className="text-sage-600">
            Every venue has its own voice. This page shows how your AI has learned it.
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <div className="w-14 h-14 rounded-full bg-sage-50 flex items-center justify-center mx-auto mb-4">
            <ArrowRightLeft className="w-7 h-7 text-sage-400" />
          </div>
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-2">
            Voice DNA is venue-specific
          </h2>
          <p className="text-sm text-sage-600 max-w-md mx-auto mb-5">
            Switch to a single venue to see its Voice DNA. Every venue builds up its own tone, approved phrases, and edit patterns.
          </p>
          <p className="text-xs text-sage-400">
            Use the scope selector in the top-left sidebar to pick a venue.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return <LoadingSkeleton />
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <Sparkles className="w-7 h-7 text-sage-500" />
            Voice DNA
          </h1>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700 flex-1">{error}</p>
          <button
            onClick={() => fetchData()}
            className="text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!data) return null

  // T5-β.2: API now 400s when ai_name isn't configured, so by the time
  // we render `data.aiName` is always a real name. Keep a neutral
  // fallback rather than "Sage" for defensive rendering.
  const aiName = data.aiName || 'your AI assistant'
  const venueName = data.venueName || 'your venue'

  // Brand-new venue callout: no phrases at all, no training, no edit loop.
  const hasAnyLearning =
    data.sampleCount > 0 ||
    data.trainingSessionCount > 0 ||
    data.editPairs.length > 0 ||
    Object.keys(data.phrasesByTheme).length > 0 ||
    Object.keys(data.marketingByTheme).length > 0

  if (!hasAnyLearning) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <Sparkles className="w-7 h-7 text-sage-500" />
            Voice DNA
          </h1>
          <p className="text-sage-600">
            {venueName}&apos;s voice, as {aiName} has learned it.
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <div className="w-14 h-14 rounded-full bg-sage-50 flex items-center justify-center mx-auto mb-4">
            <Sparkles className="w-7 h-7 text-sage-400" />
          </div>
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-2">
            {aiName} hasn&apos;t collected enough of your voice yet
          </h2>
          <p className="text-sm text-sage-600 max-w-md mx-auto mb-6">
            The fastest way: import the last 12 months of your sent email and {aiName} will mine your voice phrases automatically. Or play training games and approve review phrases to teach manually.
          </p>

          {/* B6 (2026-05-08): empty-state Gmail import. Highest-leverage
              action when there's no voice yet; pre-fix the import button
              only rendered on the main happy path so the venue most in
              need of it never saw it. */}
          <div className="flex items-center justify-center mb-4">
            <button
              type="button"
              onClick={async () => {
                setBackfilling(true)
                setBackfillError(null)
                try {
                  const res = await fetch('/api/intel/voice-dna/backfill', { method: 'POST' })
                  const json = await res.json()
                  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
                  setBackfillResult({
                    scanned: json.scanned ?? 0,
                    phrases_inserted: json.phrases_inserted ?? 0,
                    phrases_deduped: json.phrases_deduped ?? 0,
                    errors: json.errors ?? [],
                  })
                  fetchData()
                } catch (e) {
                  setBackfillError(e instanceof Error ? e.message : String(e))
                } finally {
                  setBackfilling(false)
                }
              }}
              disabled={backfilling}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-sage-600 hover:bg-sage-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {backfilling ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Importing... can take a few minutes
                </>
              ) : backfillResult ? (
                <>
                  <CheckIcon className="w-4 h-4" />
                  Import again
                </>
              ) : (
                <>
                  <Mail className="w-4 h-4" />
                  Import from Gmail history
                </>
              )}
            </button>
          </div>

          {backfillResult && (
            <p className="text-xs text-sage-600 mb-4">
              Scanned <span className="font-semibold">{backfillResult.scanned}</span> emails. Added <span className="font-semibold">{backfillResult.phrases_inserted}</span> new phrases, refreshed <span className="font-semibold">{backfillResult.phrases_deduped}</span> existing.
              {backfillResult.errors.length > 0 && (
                <span className="text-amber-700"> {backfillResult.errors.length} errors logged.</span>
              )}
            </p>
          )}
          {backfillError && (
            <p className="text-xs text-rose-700 mb-4">{backfillError}</p>
          )}

          <p className="text-xs text-sage-500 mb-3">Or teach manually:</p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link
              href="/settings/voice"
              className="inline-flex items-center gap-2 px-4 py-2.5 border border-sage-300 text-sage-700 hover:bg-sage-50 text-sm font-medium rounded-lg transition-colors"
            >
              <Mic className="w-4 h-4" />
              Play voice training games
            </Link>
            <Link
              href="/intel/reviews"
              className="inline-flex items-center gap-2 px-4 py-2.5 border border-sage-300 text-sage-700 hover:bg-sage-50 text-sm font-medium rounded-lg transition-colors"
            >
              <Quote className="w-4 h-4" />
              Approve review phrases
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const phraseThemes = Object.keys(data.phrasesByTheme)
  const marketingThemes = Object.keys(data.marketingByTheme)
  const activePhrases = activeTheme ? data.phrasesByTheme[activeTheme] ?? [] : []

  return (
    <div className="space-y-10">
      {/* =============================================================== */}
      {/* Hero header                                                      */}
      {/* =============================================================== */}
      {/*
        T5-followup-Z: bare "47 days learning" was confusing — coordinators
        didn't know what 47 days meant or what came next. Now we show three
        concrete signals from real platform data:
          - day count + learning-mode badge (so it's clear it's still learning)
          - emails seen so far (the substrate Sage learns from)
          - next milestone with a progress bar (so coordinators know what's next)
      */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-800">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Learning mode
          </span>
          <span className="text-xs text-sage-500">
            Day <span className="tabular-nums font-semibold">{data.daysLearning}</span>
          </span>
        </div>
        <h1 className="font-heading text-4xl md:text-5xl font-bold text-sage-900 mb-3 leading-tight">
          <span className="text-sage-500">{aiName}</span> is learning{' '}
          <span className="text-sage-500">{venueName}</span>&apos;s voice.
        </h1>
        <p className="text-sage-600 text-base mb-4">
          Trained on <span className="tabular-nums font-semibold text-sage-800">{data.emailsSeen}</span> outbound email{data.emailsSeen === 1 ? '' : 's'} so far.{' '}
          {data.sampleCount} phrase{data.sampleCount === 1 ? '' : 's'} mined from reviews and training.{' '}
          {data.trainingSessionCount} voice training game{data.trainingSessionCount === 1 ? '' : 's'} completed.
        </p>

        {data.nextMilestone ? (
          <div className="bg-surface border border-sage-200 rounded-xl p-4 max-w-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-sage-500 uppercase tracking-wider">
                Next milestone
              </span>
              <span className="text-xs text-sage-400 tabular-nums">
                {Math.round(Math.max(0, Math.min(1, data.nextMilestone.progress)) * 100)}%
              </span>
            </div>
            <p className="text-sm font-semibold text-sage-900 mb-1">
              {data.nextMilestone.label}
            </p>
            <p className="text-xs text-sage-600 mb-3">{data.nextMilestone.detail}</p>
            <div className="w-full h-1.5 bg-sage-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-sage-500 rounded-full transition-all duration-500"
                style={{
                  width: `${Math.round(Math.max(0, Math.min(1, data.nextMilestone.progress)) * 100)}%`,
                }}
              />
            </div>
          </div>
        ) : (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-xs font-medium text-emerald-800">
            Voice DNA mature - every milestone cleared.
          </div>
        )}

        {/* B6 (2026-05-08): Gmail history backfill. Pulls last 12 months
            of sent email through the phrase extractor, upserts into
            review_language with source_type='gmail_backfill'. Manual
            trigger (B6.3 = b); safe to re-click thanks to phrase dedup. */}
        <div className="bg-surface border border-sage-200 rounded-xl p-4 max-w-xl mt-4">
          <div className="flex items-start gap-3">
            <Mail className="w-5 h-5 text-sage-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-sage-900 mb-1">
                Import from Gmail history
              </p>
              <p className="text-xs text-sage-600 mb-3">
                Pull the last 12 months of your sent email through the voice extractor. Skips auto-replies and calendar invites. Safe to re-run; phrases dedup.
              </p>
              <button
                type="button"
                onClick={async () => {
                  setBackfilling(true)
                  setBackfillError(null)
                  try {
                    const res = await fetch('/api/intel/voice-dna/backfill', { method: 'POST' })
                    const json = await res.json()
                    if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
                    setBackfillResult({
                      scanned: json.scanned ?? 0,
                      phrases_inserted: json.phrases_inserted ?? 0,
                      phrases_deduped: json.phrases_deduped ?? 0,
                      errors: json.errors ?? [],
                    })
                    fetchData()
                  } catch (e) {
                    setBackfillError(e instanceof Error ? e.message : String(e))
                  } finally {
                    setBackfilling(false)
                  }
                }}
                disabled={backfilling}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50"
              >
                {backfilling ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Importing... can take a few minutes
                  </>
                ) : backfillResult ? (
                  <>
                    <CheckIcon className="w-4 h-4" />
                    Import again
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4" />
                    Import history
                  </>
                )}
              </button>
              {backfillResult && (
                <p className="text-xs text-sage-600 mt-2">
                  Scanned <span className="font-semibold">{backfillResult.scanned}</span> emails. Added <span className="font-semibold">{backfillResult.phrases_inserted}</span> new phrases, refreshed <span className="font-semibold">{backfillResult.phrases_deduped}</span> existing.
                  {backfillResult.errors.length > 0 && (
                    <span className="text-amber-700"> {backfillResult.errors.length} errors logged.</span>
                  )}
                </p>
              )}
              {backfillError && (
                <p className="text-xs text-rose-700 mt-2">{backfillError}</p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* =============================================================== */}
      {/* Monthly refresh state (T5-followup-EE / #94)                    */}
      {/* =============================================================== */}
      {/* Stream X added the cron + voice_dna_last_refresh_at column. The
          coordinator surface had no signal that the refresh was happening
          (or hadn't yet) — so we surface last-run time, what it learned,
          and the next scheduled fire so it stops being invisible learning. */}
      <RefreshStateCard refresh={data.refresh} aiName={aiName} />

      {/* =============================================================== */}
      {/* Tone dimensions                                                  */}
      {/* =============================================================== */}
      <section>
        <h2 className="font-heading text-xl font-semibold text-sage-900 mb-4">
          Tone dimensions
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {DIMENSION_CONFIG.map((dim) => {
            const score = data.dimensions[dim.key]
            const Icon = dim.icon
            const label = dimensionLabel(score, dim.lowLabel, dim.midLabel, dim.highLabel)
            const pct = Math.max(0, Math.min(100, (score / 10) * 100))
            return (
              <div key={dim.key} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
                <div className="flex items-center gap-2 mb-3">
                  <div className="p-1.5 rounded-lg bg-sage-50">
                    <Icon className="w-4 h-4 text-sage-600" />
                  </div>
                  <span className="text-xs font-semibold text-sage-500 uppercase tracking-wider">
                    {dim.title}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5 mb-2">
                  <span className="text-3xl font-bold text-sage-900 tabular-nums">{score}</span>
                  <span className="text-xs text-sage-400">/ 10</span>
                </div>
                <p className="text-xs text-sage-600 mb-3">{label}</p>
                <div className="w-full h-1.5 bg-sage-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-sage-500 rounded-full transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* =============================================================== */}
      {/* Sage's active context (Connective II / fix #6)                   */}
      {/* =============================================================== */}
      {/* What's actively shaping Sage's draft prompts right now —
          surfaces the same numbers that the buildSageIntelligenceContext
          service injects so coordinators can see the loop is closed. */}
      {scope.venueId && <SageActiveContextCard aiName={aiName} venueId={scope.venueId} />}

      {/* =============================================================== */}
      {/* Learned phrases (approved_for_sage)                              */}
      {/* =============================================================== */}
      <section>
        <div className="mb-4">
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-1">
            Learned phrases
          </h2>
          <p className="text-sm text-sage-600">
            Review language you&apos;ve approved for {aiName} to use. Grouped by theme, sorted by how often reviewers mention them.
          </p>
        </div>

        {phraseThemes.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center">
            <Quote className="w-10 h-10 text-sage-300 mx-auto mb-3" />
            <p className="text-sm text-sage-600">
              No phrases approved for {aiName} yet.{' '}
              <Link href="/intel/reviews" className="text-sage-700 underline hover:text-sage-900">
                Approve phrases on the reviews page
              </Link>{' '}
              to build {aiName}&apos;s vocabulary.
            </p>
          </div>
        ) : (
          <>
            {/* Theme filter tabs */}
            <div className="flex flex-wrap gap-2 mb-4">
              {phraseThemes.map((theme) => {
                const isActive = activeTheme === theme
                const colorClass = themeChipClass(theme)
                return (
                  <button
                    key={theme}
                    onClick={() => setActiveTheme(theme)}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                      isActive
                        ? colorClass
                        : 'bg-warm-white text-sage-600 border-border hover:bg-sage-50'
                    }`}
                  >
                    {formatThemeName(theme)}
                    <span className={`text-[10px] px-1.5 rounded-full ${
                      isActive ? 'bg-white/50' : 'bg-sage-100'
                    }`}>
                      {data.phrasesByTheme[theme].length}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Phrases for the selected theme */}
            <div className="bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
              {activePhrases.map((row, i) => (
                <div key={`${row.phrase}-${i}`} className="p-4 flex flex-col md:flex-row md:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2 mb-1">
                      <p className="text-sm italic text-sage-900 leading-relaxed flex-1">
                        &ldquo;{row.phrase}&rdquo;
                      </p>
                      {row.sourceType === 'transcript' && (
                        <span
                          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-teal-200 bg-teal-50 text-teal-700 text-[10px] font-medium uppercase tracking-wide"
                          title="Mined from a tour transcript (booked couple with a 5-star review)"
                        >
                          <Mic className="w-2.5 h-2.5" />
                          from tours
                        </span>
                      )}
                      {row.sourceType === 'manual' && (
                        <span
                          className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full border border-sage-200 bg-sage-50 text-sage-700 text-[10px] font-medium uppercase tracking-wide"
                          title="Added manually"
                        >
                          manual
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-sage-500">
                      Mentioned {row.frequency}x in{' '}
                      {row.sourceType === 'transcript' ? 'tours' : 'reviews'}. Used in{' '}
                      {row.usageCount} draft{row.usageCount === 1 ? '' : 's'}.
                    </p>
                  </div>
                  <div className="md:w-40 shrink-0">
                    <SentimentBar value={row.sentiment_score} />
                  </div>
                </div>
              ))}
              {activePhrases.length === 0 && (
                <p className="p-6 text-sm text-sage-500 italic text-center">
                  No phrases in this theme.
                </p>
              )}
            </div>
          </>
        )}
      </section>

      {/* =============================================================== */}
      {/* Edit loop (Task 51)                                              */}
      {/* =============================================================== */}
      <section>
        <div className="mb-4">
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-1">
            Where you and {aiName} disagree
          </h2>
          <p className="text-sm text-sage-600">
            Patterns we&apos;ve picked up from your edits. The more drafts you approve with edits, the sharper this gets.
          </p>
        </div>

        {data.editPairs.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm text-center">
            <p className="text-sm text-sage-500 italic">
              Not enough edits yet. As you approve drafts with edits, patterns appear here.
            </p>
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
            {data.editPairs.map((pair, i) => (
              <div key={`${pair.banned}-${i}`} className="p-4 flex items-start gap-3">
                <ArrowRightLeft className="w-4 h-4 text-sage-400 mt-1 shrink-0" />
                <p className="text-sm text-sage-800 leading-relaxed">
                  You consistently edit {aiName}&apos;s drafts to use{' '}
                  <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">
                    {pair.approved}
                  </span>{' '}
                  instead of{' '}
                  <span className="inline-block px-1.5 py-0.5 rounded bg-red-50 text-red-700 line-through decoration-red-400">
                    {pair.banned}
                  </span>
                  .
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* =============================================================== */}
      {/* Marketing copy (Task 49)                                         */}
      {/* =============================================================== */}
      <section>
        <div className="mb-4 flex items-start gap-3">
          <Megaphone className="w-5 h-5 text-sage-500 mt-1 shrink-0" />
          <div>
            <h2 className="font-heading text-xl font-semibold text-sage-900 mb-1">
              Marketing copy from your reviews
            </h2>
            <p className="text-sm text-sage-600">
              Use these phrases in your marketing. They&apos;re the language your happiest couples use to describe {venueName}.
            </p>
          </div>
        </div>

        {marketingThemes.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center">
            <Megaphone className="w-10 h-10 text-sage-300 mx-auto mb-3" />
            <p className="text-sm text-sage-600 mb-4">
              No review phrases approved for marketing yet.
            </p>
            <Link
              href="/intel/reviews"
              className="inline-flex items-center gap-2 px-4 py-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Quote className="w-4 h-4" />
              Approve review phrases for marketing use on the reviews page
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            {marketingThemes.map((theme) => {
              const rows = data.marketingByTheme[theme]
              return (
                <div key={theme}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${themeChipClass(theme)}`}>
                      {formatThemeName(theme)}
                    </span>
                    <span className="text-[11px] text-sage-400">
                      {rows.length} phrase{rows.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {rows.map((row, i) => (
                      <MarketingQuote key={`${theme}-${i}`} phrase={row.phrase} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* =============================================================== */}
      {/* Learning timeline                                                */}
      {/* =============================================================== */}
      <LearningTimeline timeline={data.timeline} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Refresh state card (T5-followup-EE / #94)
// ---------------------------------------------------------------------------
// Visibility for Stream X's monthly voice_dna_refresh cron. Coordinators
// see when the refresh last ran, how many phrases the most recent refresh
// surfaced, and when the next one fires. When voice_dna_last_refresh_at is
// NULL we render the "first refresh after seed" copy.

function formatRefreshDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso.slice(0, 10)
  }
}

function RefreshStateCard({
  refresh,
  aiName,
}: {
  refresh: VoiceDnaData['refresh']
  aiName: string
}) {
  const hasRun = refresh.lastRefreshedAt != null
  const daysAgo = refresh.daysSinceLastRefresh ?? 0
  const newPhrases = refresh.newPhrasesLastRefresh ?? 0
  const nextLabel = formatRefreshDate(refresh.nextRefreshAt)

  return (
    <section className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <GraduationCap className="w-4 h-4 text-sage-500" />
        <h2 className="font-heading text-base font-semibold text-sage-900">
          Monthly voice refresh
        </h2>
      </div>
      {hasRun ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="border border-sage-100 rounded-lg p-3 bg-warm-white">
            <p className="text-[10px] text-sage-500 uppercase tracking-wide">Last refreshed</p>
            <p className="text-lg font-semibold text-sage-900 tabular-nums">
              {daysAgo === 0 ? 'Today' : `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`}
            </p>
            <p className="text-[10px] text-sage-500 mt-0.5">
              {refresh.lastRefreshedAt ? formatRefreshDate(refresh.lastRefreshedAt) : ''}
            </p>
          </div>
          <div className="border border-sage-100 rounded-lg p-3 bg-warm-white">
            <p className="text-[10px] text-sage-500 uppercase tracking-wide">New phrases learned</p>
            <p className="text-lg font-semibold text-sage-900 tabular-nums">{newPhrases}</p>
            <p className="text-[10px] text-sage-500 mt-0.5">
              From the most recent refresh
            </p>
          </div>
          <div className="border border-sage-100 rounded-lg p-3 bg-warm-white">
            <p className="text-[10px] text-sage-500 uppercase tracking-wide">Next refresh</p>
            <p className="text-lg font-semibold text-sage-900 tabular-nums">{nextLabel}</p>
            <p className="text-[10px] text-sage-500 mt-0.5">
              1st of next month
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-warm-white border border-sage-100 rounded-lg p-4">
          <p className="text-sm text-sage-700">
            Voice DNA refresh hasn&apos;t run yet — first refresh will land{' '}
            <span className="font-semibold">{nextLabel}</span> (1st of next month after seed).
          </p>
          <p className="text-xs text-sage-500 mt-1">
            {aiName} re-learns from your latest outbound emails monthly so the voice stays current as your team and style evolve.
          </p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Learning timeline (stacked bars, last 12 weeks)
// ---------------------------------------------------------------------------

function LearningTimeline({ timeline }: { timeline: VoiceDnaData['timeline'] }) {
  const max = useMemo(() => {
    let m = 0
    for (const bucket of timeline) {
      const total = bucket.trainings + bucket.preferences
      if (total > m) m = total
    }
    return m
  }, [timeline])

  if (timeline.length === 0) return null

  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <GraduationCap className="w-5 h-5 text-sage-500" />
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Learning timeline
          </h2>
          <p className="text-xs text-sage-500">
            Voice training sessions and new voice preferences over the last 12 weeks.
          </p>
        </div>
      </div>
      <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
        <div className="flex items-end gap-1.5 h-24">
          {timeline.map((bucket) => {
            const total = bucket.trainings + bucket.preferences
            const height = max > 0 ? Math.max(total === 0 ? 2 : 8, (total / max) * 100) : 2
            const trainingsPct = total > 0 ? (bucket.trainings / total) * 100 : 0
            return (
              <div
                key={bucket.week}
                className="flex-1 flex flex-col justify-end group relative"
                title={`${bucket.week} — ${bucket.trainings} training${bucket.trainings === 1 ? '' : 's'}, ${bucket.preferences} preference${bucket.preferences === 1 ? '' : 's'}`}
              >
                <div
                  className="w-full rounded-t-sm overflow-hidden flex flex-col"
                  style={{ height: `${height}%` }}
                >
                  <div
                    className="bg-sage-500"
                    style={{ height: `${trainingsPct}%` }}
                  />
                  <div
                    className="bg-gold-400"
                    style={{ height: `${100 - trainingsPct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-between mt-3 text-[10px] text-sage-400">
          <span>{timeline[0].week}</span>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-sage-500" />
              Trainings
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-gold-400" />
              Preferences
            </span>
          </div>
          <span>{timeline[timeline.length - 1].week}</span>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Sage's active context card (Connective II / fix #6 — 2026-04-30)
// ---------------------------------------------------------------------------
//
// Shows the same numbers buildSageIntelligenceContext injects into
// Sage's prompt so coordinators can see what's actively shaping
// drafts. Closes the loop on PD.1 fix #3 (draft_feedback feeding
// Sage) — coordinator edits drafts, edits show up here, Sage's
// next draft already learned from them.

interface SageActiveContextCardProps {
  aiName: string
  venueId: string
}

interface SageContextCounts {
  approvedPhrases: number
  recentEditPatterns: number
  recentRejections: number
  recentApprovedExamples: number
  bannedPhrases: number
}

function SageActiveContextCard({ aiName, venueId }: SageActiveContextCardProps) {
  const [counts, setCounts] = useState<SageContextCounts | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/intel/voice-dna?venueId=${venueId}&context_only=1`)
        if (!res.ok) {
          // Fallback: hit a simpler endpoint or fail gracefully
          if (!cancelled) setCounts(null)
          return
        }
        const json = (await res.json().catch(() => null)) as { context?: SageContextCounts } | null
        if (!cancelled) setCounts(json?.context ?? null)
      } catch {
        if (!cancelled) setCounts(null)
      }
    })()
    return () => { cancelled = true }
  }, [venueId])

  // Render even when counts are zero — coordinator sees "Sage has
  // no learning yet" which is itself useful information.
  return (
    <section className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-sage-500" />
        <h2 className="font-heading text-base font-semibold text-sage-900">
          {aiName}&apos;s active context
        </h2>
      </div>
      <p className="text-xs text-sage-500 mb-3">
        What {aiName} is consulting in real-time before drafting any reply.
      </p>
      {counts ? (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <ContextStat label="Approved phrases" value={counts.approvedPhrases} hint="Review-derived voice" />
          <ContextStat label="Banned phrases" value={counts.bannedPhrases} hint="From voice training games" />
          <ContextStat label="Recent edits" value={counts.recentEditPatterns} hint="Patterns from your team last 14d" />
          <ContextStat label="Rejections" value={counts.recentRejections} hint="With reasons last 14d" />
          <ContextStat label="Approved drafts" value={counts.recentApprovedExamples} hint="Used as voice anchors" />
        </div>
      ) : (
        <p className="text-xs text-sage-400 italic">No context summary available.</p>
      )}
    </section>
  )
}

function ContextStat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="border border-sage-100 rounded-lg p-3 bg-warm-white">
      <p className="text-[10px] text-sage-500 uppercase tracking-wide">{label}</p>
      <p className="text-lg font-semibold text-sage-900 tabular-nums">{value}</p>
      <p className="text-[10px] text-sage-500 mt-0.5">{hint}</p>
    </div>
  )
}
