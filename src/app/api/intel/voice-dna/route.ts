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
// venues.name. Only when the config row is missing do we fall back to the
// literal string 'Sage'.
// ---------------------------------------------------------------------------

interface ReviewPhraseOut {
  phrase: string
  sentiment_score: number | null
  frequency: number
  usageCount: number
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
  const plan = await requirePlan(req, 'intelligence')
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

  // ----- Fetch all the raw data in parallel -------------------------------
  const [
    venueRes,
    configRes,
    phrasesRes,
    preferencesRes,
    sessionsRes,
    phraseUsageRes,
  ] = await Promise.all([
    service.from('venues').select('id, name').eq('id', venueId).maybeSingle(),
    service
      .from('venue_ai_config')
      .select('ai_name, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level')
      .eq('venue_id', venueId)
      .maybeSingle(),
    service
      .from('review_language')
      .select('phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing, created_at')
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
  ])

  const venueRow = venueRes.data
  const configRow = configRes.data
  const phrases = phrasesRes.data ?? []
  const preferences = preferencesRes.data ?? []
  const sessions = sessionsRes.data ?? []
  const phraseUsage = phraseUsageRes.data ?? []

  const aiName = (configRow?.ai_name as string | undefined) ?? 'Sage'
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
    const entry: ReviewPhraseOut = {
      phrase,
      sentiment_score: (row.sentiment_score as number | null) ?? null,
      frequency: (row.frequency as number | null) ?? 1,
      usageCount: usageByPhrase.get(phrase.toLowerCase()) ?? 0,
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

  const response: VoiceDnaResponse = {
    aiName,
    venueName,
    daysLearning,
    sampleCount: phrases.length,
    trainingSessionCount: sessions.filter((s) => s.completed_at).length,
    dimensions,
    phrasesByTheme: sageByTheme,
    marketingByTheme,
    editPairs,
    timeline,
  }

  return NextResponse.json(response)
}
