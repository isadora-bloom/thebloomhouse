/**
 * Email / interaction / draft seed helpers for §6 E2E tests.
 *
 * Added additively alongside seed.ts (which is intentionally not modified).
 * These helpers use the Supabase service role key and assume a TestContext
 * has been created via createContext() from seed.ts. All created rows are
 * cascade-deleted when the venue or wedding rows are cleaned up by seed.ts
 * (interactions.venue_id and drafts.venue_id are ON DELETE CASCADE).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { TestContext } from './seed'

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('email-seed: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  }
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return _admin
}

export interface SeededInteractionOpts {
  venueId: string
  weddingId?: string | null
  personId?: string | null
  subject?: string
  body?: string
  fromEmail?: string
  direction?: 'inbound' | 'outbound'
  gmailThreadId?: string
  gmailMessageId?: string
}

export interface SeededInteraction {
  id: string
  gmailThreadId: string
  gmailMessageId: string
}

/**
 * Insert a row into `interactions` simulating an inbound email. This is the
 * table the email-pipeline writes to after classification (there is no
 * separate `threads` table; `gmail_thread_id` groups messages).
 */
export async function seedInteraction(
  ctx: TestContext,
  opts: SeededInteractionOpts
): Promise<SeededInteraction> {
  const gmailThreadId = opts.gmailThreadId ?? `e2e-thread-${ctx.testId}-${Math.random().toString(36).slice(2, 8)}`
  const gmailMessageId = opts.gmailMessageId ?? `e2e-msg-${ctx.testId}-${Math.random().toString(36).slice(2, 8)}`

  const { data, error } = await admin()
    .from('interactions')
    .insert({
      venue_id: opts.venueId,
      wedding_id: opts.weddingId ?? null,
      person_id: opts.personId ?? null,
      type: 'email',
      direction: opts.direction ?? 'inbound',
      subject: opts.subject ?? `E2E inquiry ${ctx.testId}`,
      body_preview: (opts.body ?? 'Hi, we are interested in booking').slice(0, 300),
      full_body: opts.body ?? 'Hi, we are interested in booking your venue for July 2026.',
      gmail_thread_id: gmailThreadId,
      gmail_message_id: gmailMessageId,
      timestamp: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) throw new Error(`seedInteraction: ${error.message}`)

  const bag = ctx.extra.interactionIds ?? []
  bag.push(data.id)
  ctx.extra.interactionIds = bag

  return { id: data.id, gmailThreadId, gmailMessageId }
}

export interface SeededDraftOpts {
  venueId: string
  interactionId: string
  weddingId?: string | null
  contextType?: 'inquiry' | 'client'
  brainUsed?: string
  body?: string
  toEmail?: string
  subject?: string
  confidenceScore?: number
}

export async function seedDraft(
  ctx: TestContext,
  opts: SeededDraftOpts
): Promise<{ id: string }> {
  const { data, error } = await admin()
    .from('drafts')
    .insert({
      venue_id: opts.venueId,
      wedding_id: opts.weddingId ?? null,
      interaction_id: opts.interactionId,
      to_email: opts.toEmail ?? `couple-${ctx.testId}@test.thebloomhouse.com`,
      subject: opts.subject ?? `Re: E2E inquiry ${ctx.testId}`,
      draft_body: opts.body ?? `Thanks for reaching out. [e2e:${ctx.testId}]`,
      status: 'pending',
      context_type: opts.contextType ?? 'inquiry',
      brain_used: opts.brainUsed ?? 'inquiry',
      confidence_score: opts.confidenceScore ?? 80,
      auto_sent: false,
    })
    .select('id')
    .single()

  if (error) throw new Error(`seedDraft: ${error.message}`)

  const bag = ctx.extra.draftIds ?? []
  bag.push(data.id)
  ctx.extra.draftIds = bag

  return { id: data.id }
}

/**
 * Explicit teardown for interactions/drafts seeded in this file. Venue
 * cascade normally handles it, but use this when the venue is shared across
 * iterations within a single test.
 */
export async function cleanupEmailArtifacts(ctx: TestContext): Promise<void> {
  const a = admin()
  try {
    const draftIds = ctx.extra.draftIds ?? []
    if (draftIds.length) {
      await a.from('drafts').delete().in('id', draftIds)
    }
    const interactionIds = ctx.extra.interactionIds ?? []
    if (interactionIds.length) {
      await a.from('interactions').delete().in('id', interactionIds)
    }
  } catch (e) {
    console.warn('cleanupEmailArtifacts warning:', e)
  }
}
