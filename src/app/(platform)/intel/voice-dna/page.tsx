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
}

interface VoiceDnaData {
  aiName: string
  venueName: string
  daysLearning: number
  sampleCount: number
  trainingSessionCount: number
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

  const aiName = data.aiName || 'Sage'
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
            Play voice training games to teach {aiName} what sounds like you, and approve review phrases to build a library of quotable language.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link
              href="/settings/voice"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors"
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
      <section>
        <h1 className="font-heading text-4xl md:text-5xl font-bold text-sage-900 mb-3 leading-tight">
          <span className="text-sage-500">{aiName}</span> has been learning{' '}
          <span className="text-sage-500">{venueName}</span>&apos;s voice for{' '}
          <span className="tabular-nums">{data.daysLearning}</span>{' '}
          day{data.daysLearning === 1 ? '' : 's'}.
        </h1>
        <p className="text-sage-600 text-base">
          {data.sampleCount} phrase{data.sampleCount === 1 ? '' : 's'} mined from reviews and training.{' '}
          {data.trainingSessionCount} voice training game{data.trainingSessionCount === 1 ? '' : 's'} completed.
        </p>
      </section>

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
                    <p className="text-sm italic text-sage-900 leading-relaxed mb-1">
                      &ldquo;{row.phrase}&rdquo;
                    </p>
                    <p className="text-[11px] text-sage-500">
                      Mentioned {row.frequency}x in reviews. Used in {row.usageCount} draft{row.usageCount === 1 ? '' : 's'}.
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
