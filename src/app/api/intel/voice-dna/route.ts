import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// GET /api/intel/voice-dna
//
// Phase 5 Tasks 48, 49, 51 — Voice DNA composite endpoint. Reads the
// venue's AI personality config, mined review language, and voice training
// history, and returns a single payload tuned for the /intel/voice-dna
// page. No new tables: everything composes from existing schema.
//
// Query params:
//   venueId  uuid   optional — defaults to the caller's scoped venue
//
// Gating: intelligence plan tier (mirrors every other /api/intel/* route).
// White-label: aiName comes from venue_ai_config.ai_name, venueName from
// venues.name. If the config row is missing we 400 — this UI panel is
// brand-identity for the venue and rendering "Sage" for an Oakwood
// coordinator would be a white-label leak (T5-β).
// ---------------------------------------------------------------------------

interface ReviewPhraseOut {
  phrase: string
  sentiment_score: number | null
  frequency: number
  usageCount: number
  sourceType: 'review' | 'transcript' | 'manual'
}

interface PhrasesByTheme {
  [theme: string]: ReviewPhraseOut[]
}

interface EditPair {
  banned: string
  approved: string
}

interface TimelineBucket {
  week: string // ISO week-start date (YYYY-MM-DD)
  trainings: number
  preferences: number
}

interface VoiceDnaResponse {
  aiName: string
  venueName: string
  daysLearning: number
  sampleCount: number
  trainingSessionCount: number
  /** Outbound interactions seen by Sage — i.e. coordinator-written +
   *  Sage-drafted-and-sent emails. Powers the "trained on N emails"
   *  signal in the hero header (T5-followup-Z). */
  emailsSeen: number
  /** Next milestone the venue is working towards. Computed from the
   *  same signals the rest of the page already shows (T5-followup-Z).
   *  null when the venue has cleared every milestone (mature voice). */
  nextMilestone: {
    label: string
    progress: number    // 0..1
    detail: string
  } | null
  dimensions: {
    warmth: number
    formality: number
    playfulness: number
    brevity: number
    enthusiasm: number
  }
  phrasesByTheme: PhrasesByTheme
  marketingByTheme: PhrasesByTheme
  editPairs: EditPair[]
  timeline: TimelineBucket[]
  /** T5-followup-EE (#94). Visibility for the monthly voice-DNA refresh
   *  cron added by Stream X (vercel.json: `0 6 1 * *`). Coordinators
   *  need to see when the refresh last ran, what it learned, and when
   *  it'll fire next — otherwise the cron is invisible learning. */
  refresh: {
    /** voice_dna_last_refresh_at on venue_ai_config. NULL = never run. */
    lastRefreshedAt: string | null
    /** Whole days since the last refresh. NULL when lastRefreshedAt is NULL. */
    daysSinceLastRefresh: number | null
    /** Count of phrase_usage rows tagged 'voice_dna_refresh' since the
     *  last refresh's previous tick. Approximates "new phrases discovered
     *  in last refresh." NULL when never run. */
    newPhrasesLastRefresh: number | null
    /** ISO date for the next scheduled refresh — 1st of next UTC month. */
    nextRefreshAt: string
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mondayOfISOWeek(d: Date): Date {
  const day = d.getUTCDay() // 0=Sun, 1=Mon ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff))
  return out
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Tokenize a phrase into lowercase word set, dropping common stop words so
 * overlap detection isn't dominated by "the", "and", "a", etc.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to',
  'for', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'i', 'you', 'we', 'they', 'it', 'my', 'your', 'our', 'their', 'me',
  'us', 'them', 'this', 'that', 'these', 'those', 'so', 'very', 'with',
  'from', 'by', 'as', 'about',
])

function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (!raw || raw.length < 3) continue
    if (STOP_WORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return n
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'solo')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const service = createServiceClient()

  // ----- Resolve target venue --------------------------------------------
  const requestedVenueId = req.nextUrl.searchParams.get('venueId')
  let venueId = auth.venueId

  if (requestedVenueId && requestedVenueId !== auth.venueId) {
    // Only honour cross-venue reads when the venue belongs to the caller's
    // org. Prevents a crafted query param from reaching across tenants.
    if (!auth.orgId && !auth.isDemo) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { data: targetVenue } = await service
      .from('venues')
      .select('id, org_id')
      .eq('id', requestedVenueId)
      .maybeSingle()
    if (!targetVenue) {
      return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
    }
    if (!auth.isDemo && auth.orgId && targetVenue.org_id !== auth.orgId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    venueId = requestedVenueId
  }

  // Connective II / fix #6 (2026-04-30): lightweight "what is Sage
  // consulting right now" summary. The full Voice DNA endpoint is
  // expensive (multiple joins, dimension aggregation); this branch
  // returns just the counts for the active-context status card.
  const contextOnly = req.nextUrl.searchParams.get('context_only') === '1'
  if (contextOnly) {
    const sinceIso = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const [approved, banned, edits, rejects, goodEx] = await Promise.all([
      service.from('review_language').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('approved_for_sage', true),
      service.from('voice_preferences').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('preference_type', 'banned_phrase'),
      // T5-α.1 fix: column is `action` (text NOT NULL CHECK
      // approved/edited/rejected), not `feedback_type`. Pre-fix
      // queries returned 0 because the Postgres filter targeted a
      // non-existent column.
      service.from('draft_feedback').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('action', 'edited').gte('created_at', sinceIso),
      service.from('draft_feedback').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('action', 'rejected').gte('created_at', sinceIso),
      service.from('draft_feedback').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('action', 'approved').gte('created_at', sinceIso),
    ])
    return NextResponse.json({
      context: {
        approvedPhrases: approved.count ?? 0,
        bannedPhrases: banned.count ?? 0,
        recentEditPatterns: edits.count ?? 0,
        recentRejections: rejects.count ?? 0,
        recentApprovedExamples: goodEx.count ?? 0,
      },
    })
  }

  // ----- Fetch all the raw data in parallel -------------------------------
  // T5-followup-Z: also count outbound interactions ("emails seen by Sage")
  // so the daysLearning header can render real progress signals + the next
  // milestone instead of a bare day count.
  const [
    venueRes,
    configRes,
    phrasesRes,
    preferencesRes,
    sessionsRes,
    phraseUsageRes,
    outboundCountRes,
  ] = await Promise.all([
    service.from('venues').select('id, name').eq('id', venueId).maybeSingle(),
    service
      .from('venue_ai_config')
      .select('ai_name, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level, voice_dna_last_refresh_at')
      .eq('venue_id', venueId)
      .maybeSingle(),
    service
      .from('review_language')
      .select('phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing, source_type, created_at')
      .eq('venue_id', venueId)
      .order('frequency', { ascending: false }),
    service
      .from('voice_preferences')
      .select('preference_type, content, score, sample_count, created_at')
      .eq('venue_id', venueId),
    service
      .from('voice_training_sessions')
      .select('started_at, completed_at')
      .eq('venue_id', venueId)
      .order('started_at', { ascending: true }),
    service
      .from('phrase_usage')
      .select('phrase_text')
      .eq('venue_id', venueId),
    service
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('direction', 'outbound'),
  ])

  const venueRow = venueRes.data
  const configRow = configRes.data
  const phrases = phrasesRes.data ?? []
  const preferences = preferencesRes.data ?? []
  const sessions = sessionsRes.data ?? []
  const phraseUsage = phraseUsageRes.data ?? []

  // ai_name is required for the voice-dna panel; without it the whole
  // surface is a venue-brand identity card with the wrong name baked in.
  // T5-β: surface a useful error rather than rendering "Sage" universally.
  const resolvedAiName = (configRow?.ai_name as string | undefined)?.trim()
  if (!resolvedAiName) {
    return NextResponse.json(
      {
        error:
          'ai_name not configured for this venue. Run onboarding or set venue_ai_config.ai_name before viewing the voice DNA panel.',
      },
      { status: 400 }
    )
  }
  const aiName = resolvedAiName
  const venueName = (venueRow?.name as string | undefined) ?? ''

  // ----- Dimensions (fall back to personality-builder defaults) ----------
  const dimensions = {
    warmth: (configRow?.warmth_level as number | undefined) ?? 7,
    formality: (configRow?.formality_level as number | undefined) ?? 4,
    playfulness: (configRow?.playfulness_level as number | undefined) ?? 5,
    brevity: (configRow?.brevity_level as number | undefined) ?? 6,
    enthusiasm: (configRow?.enthusiasm_level as number | undefined) ?? 6,
  }

  // ----- daysLearning: earliest of voice_training_sessions.started_at or
  //       voice_preferences.created_at. Zero if neither exists.
  let earliest: number | null = null
  for (const s of sessions) {
    const t = s.started_at ? new Date(s.started_at as string).getTime() : null
    if (t != null && (earliest == null || t < earliest)) earliest = t
  }
  for (const p of preferences) {
    const t = p.created_at ? new Date(p.created_at as string).getTime() : null
    if (t != null && (earliest == null || t < earliest)) earliest = t
  }
  const daysLearning = earliest == null
    ? 0
    : Math.max(0, Math.floor((Date.now() - earliest) / (24 * 60 * 60 * 1000)))

  // ----- Phrase usage counts (best-effort) --------------------------------
  const usageByPhrase = new Map<string, number>()
  for (const row of phraseUsage) {
    const txt = (row.phrase_text as string | null)?.toLowerCase()
    if (!txt) continue
    usageByPhrase.set(txt, (usageByPhrase.get(txt) ?? 0) + 1)
  }

  // ----- Group phrases by theme (sage + marketing) -----------------------
  const sageByTheme: PhrasesByTheme = {}
  const marketingByTheme: PhrasesByTheme = {}

  for (const row of phrases) {
    const theme = (row.theme as string | null) ?? 'other'
    const phrase = row.phrase as string
    const rawSource = (row.source_type as string | null | undefined) ?? 'review'
    const sourceType: ReviewPhraseOut['sourceType'] =
      rawSource === 'transcript' || rawSource === 'manual' ? rawSource : 'review'
    const entry: ReviewPhraseOut = {
      phrase,
      sentiment_score: (row.sentiment_score as number | null) ?? null,
      frequency: (row.frequency as number | null) ?? 1,
      usageCount: usageByPhrase.get(phrase.toLowerCase()) ?? 0,
      sourceType,
    }
    if (row.approved_for_sage) {
      if (!sageByTheme[theme]) sageByTheme[theme] = []
      if (sageByTheme[theme].length < 5) sageByTheme[theme].push(entry)
    }
    if (row.approved_for_marketing) {
      if (!marketingByTheme[theme]) marketingByTheme[theme] = []
      if (marketingByTheme[theme].length < 3) marketingByTheme[theme].push(entry)
    }
  }

  // ----- Edit pairs: banned phrase <-> likely approved replacement --------
  const bannedPrefs = preferences.filter((p) => p.preference_type === 'banned_phrase')
  const approvedPrefs = preferences.filter((p) => p.preference_type === 'approved_phrase')

  // Pre-tokenize approved phrases once so we don't recompute per banned.
  const approvedTokens = approvedPrefs.map((p) => ({
    content: p.content as string,
    tokens: tokens(p.content as string),
  }))

  const editPairs: EditPair[] = []
  for (const banned of bannedPrefs) {
    const bannedContent = banned.content as string
    const bannedLower = bannedContent.toLowerCase()
    const bannedTokenSet = tokens(bannedContent)

    // First try substring overlap — phrases that are obvious variants.
    let match: string | null = null
    for (const a of approvedTokens) {
      const aLower = a.content.toLowerCase()
      if (aLower.length < 3 || bannedLower.length < 3) continue
      if (bannedLower.includes(aLower) || aLower.includes(bannedLower)) {
        match = a.content
        break
      }
    }

    // Then try token overlap — pairs sharing at least 1 non-stop word.
    if (!match) {
      let bestOverlap = 0
      for (const a of approvedTokens) {
        const overlap = tokenOverlap(bannedTokenSet, a.tokens)
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          match = a.content
        }
      }
      // Require at least one shared content word — avoids pairing unrelated
      // phrases just because both came from the same training session.
      if (bestOverlap < 1) match = null
    }

    if (match) editPairs.push({ banned: bannedContent, approved: match })
  }

  // ----- Timeline: last 12 ISO weeks --------------------------------------
  const now = new Date()
  const thisMonday = mondayOfISOWeek(now)
  const timeline: TimelineBucket[] = []
  const weekIndex = new Map<string, { trainings: number; preferences: number }>()

  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(thisMonday)
    weekStart.setUTCDate(weekStart.getUTCDate() - i * 7)
    const key = isoDate(weekStart)
    weekIndex.set(key, { trainings: 0, preferences: 0 })
    timeline.push({ week: key, trainings: 0, preferences: 0 })
  }

  const earliestWeek = timeline[0]?.week
  if (earliestWeek) {
    const earliestWeekMs = new Date(earliestWeek + 'T00:00:00Z').getTime()

    for (const s of sessions) {
      if (!s.started_at) continue
      const ts = new Date(s.started_at as string)
      if (ts.getTime() < earliestWeekMs) continue
      const wk = isoDate(mondayOfISOWeek(ts))
      const bucket = weekIndex.get(wk)
      if (bucket) bucket.trainings++
    }
    for (const p of preferences) {
      if (!p.created_at) continue
      const ts = new Date(p.created_at as string)
      if (ts.getTime() < earliestWeekMs) continue
      const wk = isoDate(mondayOfISOWeek(ts))
      const bucket = weekIndex.get(wk)
      if (bucket) bucket.preferences++
    }

    // Fold counts back into ordered timeline array.
    for (const bucket of timeline) {
      const counts = weekIndex.get(bucket.week)
      if (counts) {
        bucket.trainings = counts.trainings
        bucket.preferences = counts.preferences
      }
    }
  }

  const emailsSeen = outboundCountRes.count ?? 0
  const trainingCount = sessions.filter((s) => s.completed_at).length

  // T5-followup-Z: pick the next milestone in a fixed ladder using
  // signals already surfaced on the page. Each rung is something the
  // platform actually computes — no invented metrics. Coordinators
  // see "Next milestone: <human label>" instead of a bare day count.
  const nextMilestone = computeNextMilestone({
    emailsSeen,
    sampleCount: phrases.length,
    trainingCount,
    editPairsCount: editPairs.length,
    dimensions,
  })

  // T5-followup-EE (#94). Voice-DNA refresh visibility. Stream X added the
  // monthly cron + the column; this surfaces it. We compute:
  //  - lastRefreshedAt: raw timestamp (NULL on un-refreshed venues).
  //  - daysSinceLastRefresh: whole-day delta for the UI's "X days ago" copy.
  //  - newPhrasesLastRefresh: count of phrase_usage rows tagged
  //    'voice_dna_refresh' that landed AFTER lastRefreshedAt - 1 day.
  //    Approximates "phrases discovered in the most recent refresh tick."
  //    Bounded by a single window so re-renders stay cheap.
  //  - nextRefreshAt: 1st of next UTC month at 06:00 UTC (matches
  //    vercel.json cron `0 6 1 * *`).
  const lastRefreshedAt = (configRow?.voice_dna_last_refresh_at as string | null | undefined) ?? null
  let daysSinceLastRefresh: number | null = null
  let newPhrasesLastRefresh: number | null = null
  if (lastRefreshedAt) {
    const lastMs = new Date(lastRefreshedAt).getTime()
    if (!Number.isNaN(lastMs)) {
      daysSinceLastRefresh = Math.max(0, Math.floor((Date.now() - lastMs) / (24 * 60 * 60 * 1000)))
      // Window: anything tagged 'voice_dna_refresh' and inserted in a
      // 24h band ending at lastRefreshedAt is "this refresh's batch."
      // The cron writes one row per top phrase per tick; counting rows
      // is the cheapest signal that survives without a new column.
      const windowStart = new Date(lastMs - 24 * 60 * 60 * 1000).toISOString()
      const { count: refreshPhraseCount } = await service
        .from('phrase_usage')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('phrase_category', 'voice_dna_refresh')
        .gte('used_at', windowStart)
        .lte('used_at', lastRefreshedAt)
      newPhrasesLastRefresh = refreshPhraseCount ?? 0
    }
  }
  const nowDate = new Date()
  const nextRefreshAt = new Date(Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth() + 1,
    1,
    6, 0, 0, 0,
  )).toISOString()

  const response: VoiceDnaResponse = {
    aiName,
    venueName,
    daysLearning,
    sampleCount: phrases.length,
    trainingSessionCount: trainingCount,
    emailsSeen,
    nextMilestone,
    dimensions,
    phrasesByTheme: sageByTheme,
    marketingByTheme,
    editPairs,
    timeline,
    refresh: {
      lastRefreshedAt,
      daysSinceLastRefresh,
      newPhrasesLastRefresh,
      nextRefreshAt,
    },
  }

  return NextResponse.json(response)
}

/**
 * Voice-DNA milestone ladder (T5-followup-Z).
 *
 * Five rungs, each tied to an existing platform signal. Returns the
 * first unmet rung as the "next milestone" with a fractional progress
 * estimate. When every rung is met returns null (mature voice).
 *
 * Rungs are intentionally cheap to evaluate from the data we already
 * fetch — no new aggregations, no LLM inference.
 */
function computeNextMilestone(args: {
  emailsSeen: number
  sampleCount: number
  trainingCount: number
  editPairsCount: number
  dimensions: { warmth: number; formality: number; playfulness: number; brevity: number; enthusiasm: number }
}): { label: string; progress: number; detail: string } | null {
  const { emailsSeen, sampleCount, trainingCount, editPairsCount, dimensions } = args

  // Rung 1: at least 25 outbound emails so Sage has variety to learn from.
  if (emailsSeen < 25) {
    return {
      label: 'See 25 outbound emails',
      progress: emailsSeen / 25,
      detail: `${emailsSeen} of 25 outbound emails seen so far.`,
    }
  }

  // Rung 2: at least one personality slider tweaked away from default.
  // This is what tone calibration looks like in the real schema.
  const tweaked = dimensions.warmth !== 7 || dimensions.formality !== 4 ||
    dimensions.playfulness !== 5 || dimensions.brevity !== 6 || dimensions.enthusiasm !== 6
  if (!tweaked) {
    return {
      label: 'Calibrate tone',
      progress: 0,
      detail: 'Move at least one tone slider away from the default to confirm Sage matches your voice.',
    }
  }

  // Rung 3: at least 10 phrases approved-for-sage.
  if (sampleCount < 10) {
    return {
      label: 'Approve 10 review phrases',
      progress: sampleCount / 10,
      detail: `${sampleCount} of 10 phrases approved for Sage to use.`,
    }
  }

  // Rung 4: at least 1 voice-training game completed.
  if (trainingCount < 1) {
    return {
      label: 'Complete a voice training game',
      progress: 0,
      detail: 'One full game teaches Sage your edit patterns much faster than passive learning.',
    }
  }

  // Rung 5: at least 5 edit-pair patterns mined from coordinator edits.
  if (editPairsCount < 5) {
    return {
      label: 'Build 5 edit-pair patterns',
      progress: editPairsCount / 5,
      detail: `${editPairsCount} of 5 banned-vs-approved patterns learned from your edits.`,
    }
  }

  // All rungs cleared — mature voice. Caller renders the maturity
  // badge instead of a "next milestone" line.
  return null
}
