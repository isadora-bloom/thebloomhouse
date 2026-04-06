'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  MessageSquare, ThumbsUp, ThumbsDown, Zap, Trophy, ArrowLeft,
  Check, X, BarChart3, Play, Mic,
} from 'lucide-react'
import {
  SAMPLE_INQUIRIES,
  CRINGE_PHRASES,
  QUIZ_QUESTIONS,
  type SampleInquiry,
  type CringePhrase,
  type QuizQuestion,
} from '@/config/voice-training-content'

// TODO: Wire venue selector — for now we load the first venue
const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GameType = 'would_you_send' | 'cringe_or_fine' | 'quick_quiz'
type Screen = 'select' | 'playing' | 'results'

interface GameResponse {
  round_number: number
  content_type: string
  response: string
  response_reason?: string
}

interface TrainingStats {
  total_sessions: number
  completed_sessions: number
  last_played: string | null
}

interface VoicePreference {
  preference_type: 'banned_phrase' | 'approved_phrase' | 'dimension'
  content: string
  score: number
  sample_count: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fisher-Yates shuffle */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const SOURCE_LABELS: Record<string, string> = {
  the_knot: 'The Knot',
  weddingwire: 'WeddingWire',
  google: 'Google',
  instagram: 'Instagram',
  website: 'Website',
  referral: 'Referral',
}

const GAME_CONFIGS = {
  would_you_send: {
    title: 'Would You Send This?',
    description: 'Review AI-generated drafts and approve or reject them',
    icon: MessageSquare,
    rounds: 20,
    color: 'sage',
  },
  cringe_or_fine: {
    title: 'Cringe or Fine?',
    description: 'Judge common phrases — which ones sound like you?',
    icon: ThumbsUp,
    rounds: 15,
    color: 'sage',
  },
  quick_quiz: {
    title: 'Quick Voice Quiz',
    description: "Choose between two approaches to shape your AI's personality",
    icon: Zap,
    rounds: 10,
    color: 'sage',
  },
} as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VoiceTrainingPage() {
  // Global state
  const [screen, setScreen] = useState<Screen>('select')
  const [activeGame, setActiveGame] = useState<GameType | null>(null)
  const [venueId, setVenueId] = useState<string | null>(null)
  const [stats, setStats] = useState<TrainingStats>({ total_sessions: 0, completed_sessions: 0, last_played: null })
  const [preferences, setPreferences] = useState<VoicePreference[]>([])

  // Game state
  const [currentRound, setCurrentRound] = useState(0)
  const [responses, setResponses] = useState<GameResponse[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Would You Send state
  const [showReasonInput, setShowReasonInput] = useState(false)
  const [pendingChoice, setPendingChoice] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')

  // Shuffled content for current game
  const [shuffledInquiries, setShuffledInquiries] = useState<SampleInquiry[]>([])
  const [shuffledPhrases, setShuffledPhrases] = useState<CringePhrase[]>([])
  const [shuffledQuiz, setShuffledQuiz] = useState<QuizQuestion[]>([])

  // -------------------------------------------------------------------------
  // Load venue & stats
  // -------------------------------------------------------------------------

  useEffect(() => {
    async function loadVenueAndStats() {
      // Get first venue ID
      const { data: venue } = await supabase
        .from('venues')
        .select('id')
        .limit(1)
        .single()

      if (!venue) return
      setVenueId(venue.id)

      // Load training stats
      const { data: sessions } = await supabase
        .from('voice_training_sessions')
        .select('id, completed_at, started_at')
        .eq('venue_id', venue.id)
        .order('started_at', { ascending: false })

      if (sessions) {
        setStats({
          total_sessions: sessions.length,
          completed_sessions: sessions.filter((s) => s.completed_at).length,
          last_played: sessions[0]?.started_at ?? null,
        })
      }

      // Load learned preferences
      const { data: prefs } = await supabase
        .from('voice_preferences')
        .select('preference_type, content, score, sample_count')
        .eq('venue_id', venue.id)

      if (prefs) {
        setPreferences(prefs as VoicePreference[])
      }
    }

    loadVenueAndStats()
  }, [])

  // -------------------------------------------------------------------------
  // Game lifecycle
  // -------------------------------------------------------------------------

  const totalRounds = activeGame ? GAME_CONFIGS[activeGame].rounds : 0

  const startGame = useCallback(async (game: GameType) => {
    if (!venueId) return

    // Shuffle content
    if (game === 'would_you_send') {
      setShuffledInquiries(shuffle(SAMPLE_INQUIRIES).slice(0, 20))
    } else if (game === 'cringe_or_fine') {
      setShuffledPhrases(shuffle(CRINGE_PHRASES).slice(0, 15))
    } else {
      setShuffledQuiz(shuffle(QUIZ_QUESTIONS).slice(0, 10))
    }

    // Create session
    const { data: session, error } = await supabase
      .from('voice_training_sessions')
      .insert({
        venue_id: venueId,
        game_type: game,
        completed_rounds: 0,
        total_rounds: GAME_CONFIGS[game].rounds,
      })
      .select('id')
      .single()

    if (error) {
      console.error('Failed to create session:', error)
      return
    }

    setSessionId(session.id)
    setActiveGame(game)
    setCurrentRound(0)
    setResponses([])
    setShowReasonInput(false)
    setPendingChoice(null)
    setReasonText('')
    setScreen('playing')
  }, [venueId])

  const completeGame = useCallback(async () => {
    if (!sessionId || !venueId) return

    // Batch insert responses
    if (responses.length > 0) {
      const rows = responses.map((r) => ({
        session_id: sessionId,
        round_number: r.round_number,
        content_type: r.content_type,
        response: r.response,
        response_reason: r.response_reason || null,
      }))

      await supabase.from('voice_training_responses').insert(rows)
    }

    // Update session completed
    await supabase
      .from('voice_training_sessions')
      .update({
        completed_rounds: responses.length,
        completed_at: new Date().toISOString(),
      })
      .eq('id', sessionId)

    // Update voice preferences based on game type
    if (activeGame === 'cringe_or_fine') {
      for (const r of responses) {
        const phrase = r.content_type
        const isCringe = r.response === 'cringe'
        await supabase.from('voice_preferences').upsert(
          {
            venue_id: venueId,
            preference_type: isCringe ? 'banned_phrase' : 'approved_phrase',
            content: phrase,
            score: isCringe ? -1 : 1,
            sample_count: 1,
          },
          { onConflict: 'venue_id,preference_type,content' }
        )
      }
    } else if (activeGame === 'quick_quiz') {
      // Aggregate dimension scores
      const dimensionScores: Record<string, { total: number; count: number }> = {}
      for (const r of responses) {
        const dim = r.content_type // dimension name
        if (!dimensionScores[dim]) dimensionScores[dim] = { total: 0, count: 0 }
        dimensionScores[dim].total += parseFloat(r.response)
        dimensionScores[dim].count += 1
      }

      for (const [dim, { total, count }] of Object.entries(dimensionScores)) {
        await supabase.from('voice_preferences').upsert(
          {
            venue_id: venueId,
            preference_type: 'dimension',
            content: dim,
            score: total / count,
            sample_count: count,
          },
          { onConflict: 'venue_id,preference_type,content' }
        )
      }
    } else if (activeGame === 'would_you_send') {
      // Store approval pattern
      const approved = responses.filter((r) => r.response === 'send').length
      await supabase.from('voice_preferences').upsert(
        {
          venue_id: venueId,
          preference_type: 'dimension',
          content: 'draft_approval_rate',
          score: approved / responses.length,
          sample_count: responses.length,
        },
        { onConflict: 'venue_id,preference_type,content' }
      )
    }

    // Update local stats
    setStats((prev) => ({
      total_sessions: prev.total_sessions + 1,
      completed_sessions: prev.completed_sessions + 1,
      last_played: new Date().toISOString(),
    }))

    // Refresh preferences
    const { data: prefs } = await supabase
      .from('voice_preferences')
      .select('preference_type, content, score, sample_count')
      .eq('venue_id', venueId)

    if (prefs) setPreferences(prefs as VoicePreference[])

    setScreen('results')
  }, [sessionId, venueId, activeGame, responses])

  // -------------------------------------------------------------------------
  // Game-specific handlers
  // -------------------------------------------------------------------------

  // Would You Send This?
  const handleSendChoice = useCallback((choice: 'send' | 'reject') => {
    setPendingChoice(choice)
    setShowReasonInput(true)
  }, [])

  const confirmSendChoice = useCallback(() => {
    if (!pendingChoice) return
    const inquiry = shuffledInquiries[currentRound]

    setResponses((prev) => [
      ...prev,
      {
        round_number: currentRound + 1,
        content_type: inquiry.subject,
        response: pendingChoice,
        response_reason: reasonText.trim() || undefined,
      },
    ])

    setShowReasonInput(false)
    setPendingChoice(null)
    setReasonText('')

    if (currentRound + 1 >= totalRounds) {
      // Will complete on next tick
      setTimeout(() => {}, 0)
    } else {
      setCurrentRound((r) => r + 1)
    }
  }, [pendingChoice, currentRound, totalRounds, shuffledInquiries, reasonText])

  // Auto-complete when all rounds done
  useEffect(() => {
    if (screen === 'playing' && responses.length === totalRounds && totalRounds > 0) {
      completeGame()
    }
  }, [responses.length, totalRounds, screen, completeGame])

  // Cringe or Fine?
  const handleCringeChoice = useCallback((choice: 'cringe' | 'fine') => {
    const phrase = shuffledPhrases[currentRound]

    setResponses((prev) => [
      ...prev,
      {
        round_number: currentRound + 1,
        content_type: phrase.phrase,
        response: choice,
      },
    ])

    setCurrentRound((r) => r + 1)
  }, [currentRound, shuffledPhrases])

  // Quick Quiz
  const handleQuizChoice = useCallback((option: 'A' | 'B') => {
    const q = shuffledQuiz[currentRound]
    const chosen = option === 'A' ? q.optionA : q.optionB

    setResponses((prev) => [
      ...prev,
      {
        round_number: currentRound + 1,
        content_type: chosen.dimension,
        response: String(chosen.score),
      },
    ])

    setCurrentRound((r) => r + 1)
  }, [currentRound, shuffledQuiz])

  // -------------------------------------------------------------------------
  // Results calculations
  // -------------------------------------------------------------------------

  const resultData = useMemo(() => {
    if (activeGame === 'would_you_send') {
      const approved = responses.filter((r) => r.response === 'send').length
      const rejected = responses.filter((r) => r.response === 'reject')
      return {
        score: Math.round((approved / Math.max(responses.length, 1)) * 100),
        label: 'Approval Rate',
        detail: `You approved ${approved} of ${responses.length} drafts`,
        rejected,
      }
    }

    if (activeGame === 'cringe_or_fine') {
      const cringeCount = responses.filter((r) => r.response === 'cringe').length
      const cringePhrases = responses.filter((r) => r.response === 'cringe')
      return {
        score: Math.round((cringeCount / Math.max(responses.length, 1)) * 100),
        label: 'Strictness Score',
        detail: `You flagged ${cringeCount} of ${responses.length} phrases as cringe`,
        cringePhrases,
      }
    }

    // Quick Quiz
    const dimensionMap: Record<string, number[]> = {}
    for (const r of responses) {
      if (!dimensionMap[r.content_type]) dimensionMap[r.content_type] = []
      dimensionMap[r.content_type].push(parseFloat(r.response))
    }
    const dimensions = Object.entries(dimensionMap).map(([dim, scores]) => ({
      dimension: dim,
      avg: scores.reduce((a, b) => a + b, 0) / scores.length,
    }))

    return {
      score: responses.length * 10,
      label: 'Questions Answered',
      detail: `${responses.length} responses recorded across ${dimensions.length} personality dimensions`,
      dimensions,
    }
  }, [activeGame, responses])

  // -------------------------------------------------------------------------
  // Back to game selection
  // -------------------------------------------------------------------------

  const goBack = useCallback(() => {
    setScreen('select')
    setActiveGame(null)
    setSessionId(null)
    setCurrentRound(0)
    setResponses([])
    setShowReasonInput(false)
    setPendingChoice(null)
    setReasonText('')
  }, [])

  // -------------------------------------------------------------------------
  // Render: Game Selection Screen
  // -------------------------------------------------------------------------

  if (screen === 'select') {
    const bannedPhrases = preferences.filter((p) => p.preference_type === 'banned_phrase')
    const approvedPhrases = preferences.filter((p) => p.preference_type === 'approved_phrase')
    const dimensionPrefs = preferences.filter((p) => p.preference_type === 'dimension')

    return (
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <Mic className="w-8 h-8 text-sage-500" />
            Voice Training
          </h1>
          <p className="text-sage-600">
            Train your AI&apos;s voice through interactive games — pick the phrasing that sounds like you, flag what doesn&apos;t, and refine until every email feels like it came from your team.
          </p>
        </div>

        {/* Game Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {(Object.entries(GAME_CONFIGS) as [GameType, typeof GAME_CONFIGS[GameType]][]).map(
            ([key, game]) => {
              const Icon = game.icon
              return (
                <button
                  key={key}
                  onClick={() => startGame(key)}
                  disabled={!venueId}
                  className="group bg-surface border border-border rounded-xl p-6 shadow-sm text-left transition-all hover:border-sage-400 hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-sage-100 flex items-center justify-center group-hover:bg-sage-200 transition-colors">
                      <Icon className="w-5 h-5 text-sage-600" />
                    </div>
                    <span className="text-xs font-medium text-sage-500 bg-sage-50 px-2 py-0.5 rounded-full">
                      {game.rounds} rounds
                    </span>
                  </div>
                  <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
                    {game.title}
                  </h3>
                  <p className="text-sm text-sage-600">{game.description}</p>
                  <div className="mt-4 flex items-center gap-2 text-sage-500 group-hover:text-sage-700 transition-colors">
                    <Play className="w-4 h-4" />
                    <span className="text-sm font-medium">Play Now</span>
                  </div>
                </button>
              )
            }
          )}
        </div>

        {/* Training Stats */}
        <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-5 h-5 text-sage-500" />
            <h2 className="font-heading text-xl font-semibold text-sage-900">Training Stats</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-warm-white rounded-lg p-4 border border-border">
              <p className="text-2xl font-bold text-sage-900">{stats.completed_sessions}</p>
              <p className="text-sm text-sage-600">Completed Sessions</p>
            </div>
            <div className="bg-warm-white rounded-lg p-4 border border-border">
              <p className="text-2xl font-bold text-sage-900">{stats.total_sessions}</p>
              <p className="text-sm text-sage-600">Total Sessions</p>
            </div>
            <div className="bg-warm-white rounded-lg p-4 border border-border">
              <p className="text-2xl font-bold text-sage-900">
                {stats.last_played
                  ? new Date(stats.last_played).toLocaleDateString()
                  : 'Never'}
              </p>
              <p className="text-sm text-sage-600">Last Played</p>
            </div>
          </div>
        </section>

        {/* Learned Preferences */}
        {preferences.length > 0 && (
          <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Trophy className="w-5 h-5 text-sage-500" />
              <h2 className="font-heading text-xl font-semibold text-sage-900">Learned Preferences</h2>
            </div>

            {/* Dimension scores */}
            {dimensionPrefs.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-sage-700 mb-3">Personality Dimensions</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {dimensionPrefs.map((p) => (
                    <div key={p.content} className="bg-warm-white rounded-lg p-3 border border-border">
                      <p className="text-xs text-sage-500 capitalize">{p.content.replace(/_/g, ' ')}</p>
                      <p className="text-lg font-bold text-sage-900">
                        {p.score > 0 ? '+' : ''}{p.score.toFixed(1)}
                      </p>
                      <p className="text-xs text-sage-400">{p.sample_count} samples</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Banned phrases */}
            {bannedPhrases.length > 0 && (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-sage-700 mb-2">Banned Phrases</h3>
                <div className="flex flex-wrap gap-2">
                  {bannedPhrases.map((p) => (
                    <span
                      key={p.content}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-red-50 text-red-700 text-sm border border-red-200"
                    >
                      <X className="w-3 h-3" />
                      {p.content}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Approved phrases */}
            {approvedPhrases.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-sage-700 mb-2">Approved Phrases</h3>
                <div className="flex flex-wrap gap-2">
                  {approvedPhrases.map((p) => (
                    <span
                      key={p.content}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-green-50 text-green-700 text-sm border border-green-200"
                    >
                      <Check className="w-3 h-3" />
                      {p.content}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Render: Active Game Screen
  // -------------------------------------------------------------------------

  if (screen === 'playing') {
    const progress = totalRounds > 0 ? ((currentRound) / totalRounds) * 100 : 0

    return (
      <div className="space-y-6">
        {/* Back button + title */}
        <div className="flex items-center gap-3">
          <button
            onClick={goBack}
            className="flex items-center gap-1.5 text-sage-500 hover:text-sage-700 transition-colors text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <h2 className="font-heading text-xl font-semibold text-sage-900">
            {activeGame && GAME_CONFIGS[activeGame].title}
          </h2>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-sage-700">
              Round {currentRound + 1} of {totalRounds}
            </span>
            <span className="text-sm text-sage-500">{Math.round(progress)}%</span>
          </div>
          <div className="w-full h-2.5 bg-sage-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-sage-500 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Game content area */}
        <div className="min-h-[400px]">
          {/* ============================================================ */}
          {/* Would You Send This?                                          */}
          {/* ============================================================ */}
          {activeGame === 'would_you_send' && currentRound < totalRounds && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Original Inquiry */}
                <div className="bg-sage-50 border border-sage-200 rounded-xl p-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-sage-700 uppercase tracking-wider">
                      Original Inquiry
                    </h3>
                    <span className="text-xs font-medium text-sage-500 bg-sage-100 px-2 py-0.5 rounded-full">
                      {SOURCE_LABELS[shuffledInquiries[currentRound]?.source] ?? 'Unknown'}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-sage-900 mb-2">
                    Subject: {shuffledInquiries[currentRound]?.subject}
                  </p>
                  <p className="text-sm text-sage-700 leading-relaxed">
                    {shuffledInquiries[currentRound]?.body}
                  </p>
                </div>

                {/* AI Draft Response */}
                <div className="bg-warm-white border border-border rounded-xl p-6">
                  <h3 className="text-sm font-semibold text-sage-700 uppercase tracking-wider mb-3">
                    AI Draft Response
                  </h3>
                  <div className="text-sm text-sage-800 leading-relaxed whitespace-pre-line">
                    {shuffledInquiries[currentRound]?.draft}
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              {!showReasonInput ? (
                <div className="flex items-center justify-center gap-4">
                  <button
                    onClick={() => handleSendChoice('send')}
                    className="flex items-center gap-2 px-8 py-3 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-xl transition-colors shadow-sm text-lg"
                  >
                    <Check className="w-5 h-5" />
                    Send It
                  </button>
                  <button
                    onClick={() => handleSendChoice('reject')}
                    className="flex items-center gap-2 px-8 py-3 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-xl transition-colors shadow-sm text-lg"
                  >
                    <X className="w-5 h-5" />
                    Reject
                  </button>
                </div>
              ) : (
                <div className="bg-surface border border-border rounded-xl p-6 max-w-lg mx-auto space-y-4">
                  <p className="text-sm text-sage-700">
                    <span className="font-medium">
                      {pendingChoice === 'send' ? 'Approved!' : 'Rejected.'}
                    </span>{' '}
                    Want to say why? (optional)
                  </p>
                  <textarea
                    value={reasonText}
                    onChange={(e) => setReasonText(e.target.value)}
                    placeholder={
                      pendingChoice === 'reject'
                        ? 'e.g. "Too long", "Sounds robotic", "Wrong tone"...'
                        : 'e.g. "Great tone", "Love the personal touch"...'
                    }
                    className="w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm resize-none"
                    rows={3}
                  />
                  <div className="flex items-center gap-3">
                    <button
                      onClick={confirmSendChoice}
                      className="px-6 py-2 bg-sage-500 hover:bg-sage-600 text-white font-medium rounded-lg transition-colors text-sm"
                    >
                      {reasonText.trim() ? 'Submit & Continue' : 'Skip & Continue'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============================================================ */}
          {/* Cringe or Fine?                                               */}
          {/* ============================================================ */}
          {activeGame === 'cringe_or_fine' && currentRound < totalRounds && (
            <div className="flex flex-col items-center justify-center min-h-[350px] space-y-8">
              {/* Phrase */}
              <div className="text-center max-w-lg">
                <p className="font-heading text-2xl sm:text-3xl italic text-sage-900 leading-relaxed">
                  &ldquo;{shuffledPhrases[currentRound]?.phrase}&rdquo;
                </p>
                <p className="text-sm text-sage-500 mt-4">
                  Context: {shuffledPhrases[currentRound]?.context}
                </p>
              </div>

              {/* Buttons */}
              <div className="flex items-center gap-6">
                <button
                  onClick={() => handleCringeChoice('cringe')}
                  className="flex flex-col items-center gap-2 px-8 py-4 bg-red-50 hover:bg-red-100 border-2 border-red-200 hover:border-red-400 text-red-700 font-semibold rounded-xl transition-all shadow-sm"
                >
                  <ThumbsDown className="w-6 h-6" />
                  <span className="text-lg">Cringe</span>
                </button>
                <button
                  onClick={() => handleCringeChoice('fine')}
                  className="flex flex-col items-center gap-2 px-8 py-4 bg-green-50 hover:bg-green-100 border-2 border-green-200 hover:border-green-400 text-green-700 font-semibold rounded-xl transition-all shadow-sm"
                >
                  <ThumbsUp className="w-6 h-6" />
                  <span className="text-lg">Fine</span>
                </button>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* Quick Voice Quiz                                              */}
          {/* ============================================================ */}
          {activeGame === 'quick_quiz' && currentRound < totalRounds && (
            <div className="flex flex-col items-center justify-center min-h-[350px] space-y-8">
              {/* Question */}
              <p className="font-heading text-xl sm:text-2xl text-sage-900 text-center max-w-lg leading-relaxed">
                {shuffledQuiz[currentRound]?.question}
              </p>

              {/* Options */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl">
                <button
                  onClick={() => handleQuizChoice('A')}
                  className="group bg-warm-white border-2 border-border hover:border-sage-400 rounded-xl p-5 text-left transition-all hover:shadow-md"
                >
                  <span className="inline-block text-xs font-bold text-sage-400 bg-sage-50 rounded-full w-6 h-6 flex items-center justify-center mb-2 group-hover:bg-sage-100 group-hover:text-sage-600 transition-colors">
                    A
                  </span>
                  <p className="text-sm text-sage-800 leading-relaxed">
                    {shuffledQuiz[currentRound]?.optionA.text}
                  </p>
                </button>
                <button
                  onClick={() => handleQuizChoice('B')}
                  className="group bg-warm-white border-2 border-border hover:border-sage-400 rounded-xl p-5 text-left transition-all hover:shadow-md"
                >
                  <span className="inline-block text-xs font-bold text-sage-400 bg-sage-50 rounded-full w-6 h-6 flex items-center justify-center mb-2 group-hover:bg-sage-100 group-hover:text-sage-600 transition-colors">
                    B
                  </span>
                  <p className="text-sm text-sage-800 leading-relaxed">
                    {shuffledQuiz[currentRound]?.optionB.text}
                  </p>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Render: Results Screen
  // -------------------------------------------------------------------------

  if (screen === 'results' && resultData) {
    return (
      <div className="space-y-8">
        {/* Back button */}
        <button
          onClick={goBack}
          className="flex items-center gap-1.5 text-sage-500 hover:text-sage-700 transition-colors text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Games
        </button>

        {/* Score card */}
        <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center">
          <Trophy className="w-12 h-12 text-sage-500 mx-auto mb-4" />
          <h2 className="font-heading text-2xl font-bold text-sage-900 mb-2">
            {activeGame && GAME_CONFIGS[activeGame].title} — Complete!
          </h2>
          <div className="my-6">
            <p className="text-6xl font-bold text-sage-900">
              {resultData.score}
              {activeGame !== 'quick_quiz' && <span className="text-3xl text-sage-500">%</span>}
            </p>
            <p className="text-sm text-sage-600 mt-1">{resultData.label}</p>
          </div>
          <p className="text-sage-600">{resultData.detail}</p>
        </div>

        {/* Game-specific breakdown */}
        {activeGame === 'would_you_send' && 'rejected' in resultData && (
          <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-4">Rejected Drafts</h3>
            {(resultData.rejected as GameResponse[]).length === 0 ? (
              <p className="text-sm text-sage-500 italic">
                You approved every draft! Your AI&apos;s voice is already well-aligned.
              </p>
            ) : (
              <div className="space-y-3">
                {(resultData.rejected as GameResponse[]).map((r, i) => (
                  <div key={i} className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="text-sm font-medium text-red-800">
                      Round {r.round_number}: &ldquo;{r.content_type}&rdquo;
                    </p>
                    {r.response_reason && (
                      <p className="text-sm text-red-600 mt-1">
                        Reason: {r.response_reason}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {activeGame === 'cringe_or_fine' && 'cringePhrases' in resultData && (
          <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-4">Phrases Marked Cringe</h3>
            {(resultData.cringePhrases as GameResponse[]).length === 0 ? (
              <p className="text-sm text-sage-500 italic">
                You didn&apos;t flag any phrases! Pretty tolerant voice style.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(resultData.cringePhrases as GameResponse[]).map((r, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-red-50 text-red-700 text-sm border border-red-200"
                  >
                    <X className="w-3 h-3" />
                    {r.content_type}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        {activeGame === 'quick_quiz' && 'dimensions' in resultData && (
          <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-4">Personality Profile</h3>
            <div className="space-y-4">
              {(resultData.dimensions as { dimension: string; avg: number }[]).map((d) => {
                const label = d.dimension.charAt(0).toUpperCase() + d.dimension.slice(1)
                const isPositive = d.avg > 0
                const barWidth = Math.abs(d.avg) * 50 // 0-1 -> 0-50%

                return (
                  <div key={d.dimension}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-sage-700">{label}</span>
                      <span className={`text-sm font-bold ${isPositive ? 'text-green-600' : 'text-amber-600'}`}>
                        {isPositive ? '+' : ''}{d.avg.toFixed(1)}
                      </span>
                    </div>
                    <div className="w-full h-3 bg-sage-100 rounded-full overflow-hidden relative">
                      {/* Center line */}
                      <div className="absolute left-1/2 top-0 w-px h-full bg-sage-300" />
                      {/* Bar */}
                      <div
                        className={`absolute top-0 h-full rounded-full transition-all duration-500 ${
                          isPositive ? 'bg-green-400' : 'bg-amber-400'
                        }`}
                        style={{
                          left: isPositive ? '50%' : `${50 - barWidth}%`,
                          width: `${barWidth}%`,
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Play again */}
        <div className="flex justify-center pb-8">
          <button
            onClick={goBack}
            className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 text-white font-medium rounded-lg px-6 py-2.5 transition-colors"
          >
            <Play className="w-4 h-4" />
            Back to Games
          </button>
        </div>
      </div>
    )
  }

  // Fallback
  return null
}
