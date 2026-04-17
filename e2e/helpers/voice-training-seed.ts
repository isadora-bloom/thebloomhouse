/**
 * Seed helper for §7 Voice Training tests.
 *
 * These helpers create voice_training_sessions, voice_training_responses,
 * and voice_preferences rows directly via the service role client. The
 * IDs are tracked in a local array (not the shared TestContext) so the
 * spec must clean them up manually in afterEach.
 *
 * We deliberately do not modify e2e/helpers/seed.ts.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('voice-training-seed: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from env')
  }
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return _admin
}

export type GameType = 'would_you_send' | 'cringe_or_fine' | 'quick_quiz'

export interface VoiceTrainingContext {
  sessionIds: string[]
  preferenceIds: string[]
  venueIds: string[]
}

export function createVoiceTrainingContext(): VoiceTrainingContext {
  return { sessionIds: [], preferenceIds: [], venueIds: [] }
}

export async function createTrainingSession(
  vtCtx: VoiceTrainingContext,
  opts: {
    venueId: string
    gameType?: GameType
    totalRounds?: number
    staffEmail?: string
    completed?: boolean
  }
): Promise<{ sessionId: string }> {
  const gameType = opts.gameType ?? 'cringe_or_fine'
  const totalRounds = opts.totalRounds ?? 15
  const { data, error } = await admin()
    .from('voice_training_sessions')
    .insert({
      venue_id: opts.venueId,
      game_type: gameType,
      total_rounds: totalRounds,
      completed_rounds: opts.completed ? totalRounds : 0,
      staff_email: opts.staffEmail ?? null,
      completed_at: opts.completed ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (error) throw new Error(`createTrainingSession: ${error.message}`)
  vtCtx.sessionIds.push(data.id)
  vtCtx.venueIds.push(opts.venueId)
  return { sessionId: data.id }
}

export async function insertTrainingResponses(
  sessionId: string,
  responses: Array<{
    round_number: number
    content_type: string
    response: string
    response_reason?: string
  }>
): Promise<void> {
  if (responses.length === 0) return
  const rows = responses.map((r) => ({
    session_id: sessionId,
    round_number: r.round_number,
    content_type: r.content_type,
    response: r.response,
    response_reason: r.response_reason ?? null,
  }))
  const { error } = await admin().from('voice_training_responses').insert(rows)
  if (error) throw new Error(`insertTrainingResponses: ${error.message}`)
}

export async function upsertVoicePreference(
  vtCtx: VoiceTrainingContext,
  opts: {
    venueId: string
    preferenceType: 'banned_phrase' | 'approved_phrase' | 'dimension'
    content: string
    score?: number
    sampleCount?: number
  }
): Promise<{ id: string }> {
  const { data, error } = await admin()
    .from('voice_preferences')
    .upsert(
      {
        venue_id: opts.venueId,
        preference_type: opts.preferenceType,
        content: opts.content,
        score: opts.score ?? 1,
        sample_count: opts.sampleCount ?? 1,
      },
      { onConflict: 'venue_id,preference_type,content' }
    )
    .select('id')
    .single()
  if (error) throw new Error(`upsertVoicePreference: ${error.message}`)
  vtCtx.preferenceIds.push(data.id)
  if (!vtCtx.venueIds.includes(opts.venueId)) vtCtx.venueIds.push(opts.venueId)
  return { id: data.id }
}

export async function cleanupVoiceTraining(vtCtx: VoiceTrainingContext): Promise<void> {
  const a = admin()
  try {
    if (vtCtx.sessionIds.length) {
      // Responses cascade on session delete, but clear explicitly to be safe.
      await a.from('voice_training_responses').delete().in('session_id', vtCtx.sessionIds)
      await a.from('voice_training_sessions').delete().in('id', vtCtx.sessionIds)
    }
    if (vtCtx.preferenceIds.length) {
      await a.from('voice_preferences').delete().in('id', vtCtx.preferenceIds)
    }
    // Belt and braces: remove anything left pinned to the test venue(s).
    if (vtCtx.venueIds.length) {
      await a.from('voice_preferences').delete().in('venue_id', vtCtx.venueIds)
      await a.from('voice_training_sessions').delete().in('venue_id', vtCtx.venueIds)
    }
  } catch (e) {
    console.warn('cleanupVoiceTraining warning:', e)
  }
}
