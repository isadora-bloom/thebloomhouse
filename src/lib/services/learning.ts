/**
 * Bloom House: Learning Service
 *
 * Stores feedback on AI drafts and uses it to improve future responses.
 * - Approved drafts become good examples
 * - Edited drafts show preferred corrections
 * - Rejected drafts (with reasons) show what to avoid
 *
 * Ported from bloom-agent backend/services/learning.py
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoodExample {
  subject: string
  body: string
}

export interface EditPattern {
  original: string
  edited: string
}

export interface LearningContext {
  goodExamples: GoodExample[]
  rejectionReasons: string[]
  editPatterns: EditPattern[]
}

export interface VoicePreferences {
  bannedPhrases: string[]
  approvedPhrases: string[]
  dimensions: Record<string, number>
}

export interface FeedbackStats {
  periodDays: number
  totalFeedback: number
  approved: number
  edited: number
  rejected: number
  approvalRate: number
  editRate: number
}

// ---------------------------------------------------------------------------
// Store feedback
// ---------------------------------------------------------------------------

/**
 * Record an approved draft as a good example for future AI generation.
 */
export async function storeApproval(
  venueId: string,
  draftId: string,
  originalBody: string,
  originalSubject = '',
  emailCategory = 'inquiry'
): Promise<string> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('draft_feedback')
    .insert({
      venue_id: venueId,
      draft_id: draftId,
      feedback_type: 'approved',
      original_subject: originalSubject,
      original_body: originalBody,
      email_category: emailCategory,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Record an edited draft to learn from coordinator corrections.
 */
export async function storeEdit(
  venueId: string,
  draftId: string,
  originalBody: string,
  editedBody: string,
  coordinatorEdits?: string,
  originalSubject = '',
  editedSubject = '',
  emailCategory = 'inquiry'
): Promise<string> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('draft_feedback')
    .insert({
      venue_id: venueId,
      draft_id: draftId,
      feedback_type: 'edited',
      original_subject: originalSubject,
      original_body: originalBody,
      edited_subject: editedSubject,
      edited_body: editedBody,
      coordinator_edits: coordinatorEdits,
      email_category: emailCategory,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Record a rejected draft with reason to learn what to avoid.
 */
export async function storeRejection(
  venueId: string,
  draftId: string,
  originalBody: string,
  rejectionReason: string,
  originalSubject = '',
  emailCategory = 'inquiry'
): Promise<string> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('draft_feedback')
    .insert({
      venue_id: venueId,
      draft_id: draftId,
      feedback_type: 'rejected',
      original_subject: originalSubject,
      original_body: originalBody,
      rejection_reason: rejectionReason,
      email_category: emailCategory,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

// ---------------------------------------------------------------------------
// Retrieve learning data
// ---------------------------------------------------------------------------

/**
 * Get recent approved/edited drafts as examples for the AI.
 */
async function getGoodExamples(
  venueId: string,
  category = 'inquiry',
  limit = 3
): Promise<GoodExample[]> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('draft_feedback')
    .select('original_subject, original_body, edited_subject, edited_body, feedback_type')
    .eq('venue_id', venueId)
    .eq('email_category', category)
    .in('feedback_type', ['approved', 'edited'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (!data) return []

  return data.map((row) => {
    // If edited, use the edited version as the "good" example
    if (row.feedback_type === 'edited' && row.edited_body) {
      return {
        subject: row.edited_subject ?? row.original_subject ?? '',
        body: row.edited_body,
      }
    }
    return {
      subject: row.original_subject ?? '',
      body: row.original_body ?? '',
    }
  })
}

/**
 * Get recent rejection reasons to know what to avoid.
 */
async function getRejectionReasons(
  venueId: string,
  category = 'inquiry',
  limit = 5
): Promise<string[]> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('draft_feedback')
    .select('rejection_reason')
    .eq('venue_id', venueId)
    .eq('email_category', category)
    .eq('feedback_type', 'rejected')
    .not('rejection_reason', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (!data) return []
  return data
    .map((row) => row.rejection_reason as string)
    .filter(Boolean)
}

/**
 * Get recent edits to understand correction patterns.
 */
async function getEditPatterns(
  venueId: string,
  category = 'inquiry',
  limit = 3
): Promise<EditPattern[]> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('draft_feedback')
    .select('original_body, edited_body')
    .eq('venue_id', venueId)
    .eq('email_category', category)
    .eq('feedback_type', 'edited')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (!data) return []

  return data
    .filter((row) => row.original_body && row.edited_body)
    .map((row) => ({
      original: (row.original_body as string).slice(0, 500),
      edited: (row.edited_body as string).slice(0, 500),
    }))
}

// ---------------------------------------------------------------------------
// Aggregated context
// ---------------------------------------------------------------------------

/**
 * Get all learning context for the AI to reference when generating drafts.
 */
export async function getLearningContext(
  venueId: string,
  category = 'inquiry'
): Promise<LearningContext> {
  const [goodExamples, rejectionReasons, editPatterns] = await Promise.all([
    getGoodExamples(venueId, category, 3),
    getRejectionReasons(venueId, category, 5),
    getEditPatterns(venueId, category, 3),
  ])

  return { goodExamples, rejectionReasons, editPatterns }
}

// ---------------------------------------------------------------------------
// Voice preferences
// ---------------------------------------------------------------------------

/**
 * Get voice preferences learned from voice training games.
 */
export async function getVoicePreferences(venueId: string): Promise<VoicePreferences> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('voice_preferences')
    .select('preference_type, content, score')
    .eq('venue_id', venueId)

  const preferences: VoicePreferences = {
    bannedPhrases: [],
    approvedPhrases: [],
    dimensions: {},
  }

  if (!data) return preferences

  for (const pref of data) {
    const prefType = pref.preference_type as string
    const content = pref.content as string
    const score = (pref.score as number) ?? 0

    if (prefType === 'banned_phrase') {
      preferences.bannedPhrases.push(content)
    } else if (prefType === 'approved_phrase') {
      preferences.approvedPhrases.push(content)
    } else if (prefType === 'dimension') {
      preferences.dimensions[content] = score
    }
  }

  return preferences
}

// ---------------------------------------------------------------------------
// Feedback stats
// ---------------------------------------------------------------------------

/**
 * Get statistics on draft feedback for a venue.
 */
export async function getFeedbackStats(venueId: string, days = 30): Promise<FeedbackStats> {
  const supabase = createServiceClient()

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const { data } = await supabase
    .from('draft_feedback')
    .select('feedback_type')
    .eq('venue_id', venueId)
    .gte('created_at', since)

  const rows = data ?? []
  const approved = rows.filter((r) => r.feedback_type === 'approved').length
  const edited = rows.filter((r) => r.feedback_type === 'edited').length
  const rejected = rows.filter((r) => r.feedback_type === 'rejected').length
  const total = approved + edited + rejected

  return {
    periodDays: days,
    totalFeedback: total,
    approved,
    edited,
    rejected,
    approvalRate: total > 0 ? Math.round(((approved + edited) / total) * 1000) / 10 : 0,
    editRate: total > 0 ? Math.round((edited / total) * 1000) / 10 : 0,
  }
}
