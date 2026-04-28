/**
 * Escalation detector — couple-side message paths.
 *
 * Wraps the canonical `checkEscalation` helper from
 * `@/config/escalation-keywords` and, on match, fires a single
 * `admin_notifications` row with type='escalation'.
 *
 * Used by:
 *   - /api/couple/messages POST   (couple → coordinator messages)
 *   - /api/portal/sage     POST   (couple → Sage chat)
 *
 * The email pipeline (router-brain.ts) keeps its existing direct usage —
 * this module is for the message paths it doesn't cover.
 *
 * Design notes:
 *   - Fire-and-forget. Never throws. Failures log and return so the
 *     caller's message insert is unaffected.
 *   - Only the FIRST matched keyword fires a notification per call —
 *     `checkEscalation` already short-circuits, so one message → one row.
 *   - Dedup is delegated to `createNotification` (5-minute window per
 *     venue+wedding+type), which is enough to keep accidental retries
 *     from doubling up while letting genuinely separate escalations fire.
 */

import { checkEscalation } from '@/config/escalation-keywords'
import { createServiceClient } from '@/lib/supabase/service'
import { createNotification } from '@/lib/services/admin-notifications'

export type EscalationSourceType = 'couple_message' | 'sage_conversation'

export interface RunEscalationCheckArgs {
  text: string
  venueId: string
  weddingId?: string | null
  sourceType: EscalationSourceType
  /** Row id of the underlying message / sage_conversation. Optional. */
  sourceId?: string | null
}

export interface RunEscalationCheckResult {
  escalated: boolean
  matchedKeyword: string | null
}

const SOURCE_LABEL: Record<EscalationSourceType, string> = {
  couple_message: 'message',
  sage_conversation: 'Sage chat',
}

/**
 * Resolve a human-readable couple name for the notification title.
 * Falls back to "couple" if anything goes wrong — never throws.
 */
async function resolveCoupleName(weddingId: string | null | undefined): Promise<string> {
  if (!weddingId) return 'couple'
  try {
    const supabase = createServiceClient()
    const { data: people } = await supabase
      .from('people')
      .select('first_name, last_name, role')
      .eq('wedding_id', weddingId)
      .in('role', ['partner1', 'partner2'])

    if (!people || people.length === 0) return 'couple'

    const names = people
      .map((p) => p.first_name as string | null)
      .filter((n): n is string => !!n && n.trim().length > 0)

    if (names.length === 0) return 'couple'
    if (names.length === 1) return names[0]
    return `${names[0]} & ${names[1]}`
  } catch {
    return 'couple'
  }
}

/**
 * Build the `link` deeplink coordinators jump to from the notification.
 * Currently we route everything to the wedding detail page — that's where
 * messages and Sage conversations are reviewed.
 */
function buildLink(weddingId: string | null | undefined): string | null {
  if (!weddingId) return null
  return `/portal/weddings/${weddingId}`
}

/**
 * Scan `text` for escalation keywords. On match, create one
 * `admin_notifications` row (type='escalation'). Fire-and-forget — never
 * throws, never blocks the caller's primary insert.
 */
export async function runEscalationCheck(
  args: RunEscalationCheckArgs
): Promise<RunEscalationCheckResult> {
  try {
    const { text, venueId, weddingId, sourceType } = args
    if (!text || !venueId) {
      return { escalated: false, matchedKeyword: null }
    }

    const { shouldEscalate, matchedKeyword } = checkEscalation(text)
    if (!shouldEscalate || !matchedKeyword) {
      return { escalated: false, matchedKeyword: null }
    }

    const coupleName = await resolveCoupleName(weddingId)
    const sourceLabel = SOURCE_LABEL[sourceType]
    const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text
    const link = buildLink(weddingId)
    const linkSuffix = link ? `\n\nLink: ${link}` : ''

    await createNotification({
      venueId,
      weddingId: weddingId ?? undefined,
      type: 'escalation',
      title: `Escalation: "${matchedKeyword}" from ${coupleName}`,
      body: `Detected in ${sourceLabel}: "${excerpt}"${linkSuffix}`,
    })

    return { escalated: true, matchedKeyword }
  } catch (err) {
    console.error('[escalation-detector] Failed to run escalation check:', err)
    return { escalated: false, matchedKeyword: null }
  }
}
