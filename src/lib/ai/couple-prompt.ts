/**
 * Bloom House: Canonical Couple-Facing Prompt Assembler
 *
 * One entry point for every couple-facing LLM call. Replaces the five
 * different prompt assemblies catalogued in LLM-CALL-INVENTORY.md
 * "Couple-facing observation":
 *
 *   1. The 4-layer Sage stack (UNIVERSAL_RULES + personality + task +
 *      KB + intel + wedding) used by sage-brain.
 *   2. The contract-suite ad-hoc prompts that had no venue identity at
 *      all ("wedding contract analysis specialist", etc.).
 *   3. The portal file-extraction call that opened with a generic
 *      "document text extraction specialist".
 *   4. The event-feedback proactive review draft ("You are a
 *      professional wedding venue coordinator").
 *   5. The public sage-preview that built ai_name + dials inline but
 *      skipped UNIVERSAL_RULES.
 *   6. The onboarding test-draft that opened with `You are an AI
 *      assistant for "${venueName}"` — no ai_name, no UNIVERSAL_RULES.
 *
 * All six now route through buildCouplePrompt(). Couples hear the same
 * configured concierge voice no matter which surface they hit.
 *
 * The assembler is venue-agnostic: it reads venue_ai_config + KB +
 * wedding context, and layers them with the same UNIVERSAL_RULES +
 * COUPLE_RULES + per-task block every time. There are no per-venue
 * branches.
 *
 * Per the LLM-CALL-INVENTORY findings + the 5-different-voices fix.
 */

import {
  buildPersonalityPrompt,
} from '@/lib/ai/personality-builder'
import { loadPersonalityDataCached } from '@/lib/services/brain/client'
import { dedupePeopleByName } from '@/lib/utils/couple-name'
import { createServiceClient } from '@/lib/supabase/service'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { COUPLE_RULES } from '@/config/prompts/couple-rules'
import {
  TASK_CONTRACT_ANALYSIS,
  TASK_FILE_CHAT,
  getSageTaskPrompt,
} from '@/config/prompts/task-prompts-sage'

// ---------------------------------------------------------------------------
// Prompt-version constants — one per task. Threaded into api_costs.
// ---------------------------------------------------------------------------
//
// Versioning rule (PROMPTS-CHANGELOG.md): bump on assembled-output
// structural change. Each task's version covers the COUPLE_RULES block +
// task-specific guidance + framing. Couple-facing chat already shipped
// at sage-brain.prompt.v1.2; sage-brain now routes through this
// assembler, so the chat version lives here as couple-chat.prompt.v2
// (the v2 jump captures the move from inline assembly to the unified
// assembler + the new COUPLE_RULES floor).
export const COUPLE_PROMPT_VERSIONS = {
  chat: 'couple-chat.prompt.v2',
  contract_question: 'couple-contract.prompt.v1',
  event_feedback: 'couple-event-feedback.prompt.v1',
  file_extraction: 'couple-file-extraction.prompt.v1',
  preview: 'couple-sage-preview.prompt.v1',
  onboarding_test_draft: 'couple-onboarding-test.prompt.v1',
} as const

export type CouplePromptTask = keyof typeof COUPLE_PROMPT_VERSIONS

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CouplePromptContext {
  venueId: string
  /** When present, includes a WEDDING CONTEXT block built from the live wedding row. */
  weddingId?: string | null
  /** For contract / KB / document tasks, the document text the model is allowed to cite. */
  fileContext?: string | null
  task: CouplePromptTask
  /** Task-specific rules layered on top of the universal + couple rules. */
  taskInstructions: string
}

export interface BuiltCouplePrompt {
  /** Assembled system prompt: UNIVERSAL_RULES + COUPLE_RULES + personality + task + wedding + file. */
  systemPrompt: string
  /** Per-task version constant — log to api_costs.prompt_version. */
  promptVersion: string
  /**
   * Sensitivity tier per Playbook 21.3.1.
   *   1 = wedding-linked PII or potentially sensitive document text.
   *   2 = no wedding link AND no file context (default).
   */
  contentTier: 1 | 2
}

/**
 * Build the canonical couple-facing system prompt. Loads venue
 * personality, optionally loads wedding context, optionally embeds the
 * file text, and threads the right prompt version for analytics.
 *
 * Callers keep their own user prompt + JSON contract; this function
 * only owns the system-prompt side.
 */
export async function buildCouplePrompt(
  ctx: CouplePromptContext
): Promise<BuiltCouplePrompt> {
  const personalityData = await loadPersonalityDataCached(ctx.venueId)
  const personalityPrompt = buildPersonalityPrompt(personalityData)

  const weddingBlock = ctx.weddingId
    ? await buildWeddingContextBlock(ctx.weddingId)
    : ''

  const fileBlock = ctx.fileContext
    ? buildFileContextBlock(ctx.fileContext)
    : ''

  const taskBlock = composeTaskBlock(ctx.task, ctx.taskInstructions)

  const systemPrompt = [
    UNIVERSAL_RULES,
    COUPLE_RULES,
    personalityPrompt,
    taskBlock,
    weddingBlock,
    fileBlock,
  ]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .join('\n\n')

  // contentTier policy: any wedding link OR any file context is tier-1.
  // Wedding-linked surfaces carry partner names / dates / family signals;
  // file context can carry contract PII (names, financial terms, vendor
  // contacts). Public preview + onboarding test-draft default to tier-2.
  const contentTier: 1 | 2 = ctx.weddingId || ctx.fileContext ? 1 : 2

  return {
    systemPrompt,
    promptVersion: COUPLE_PROMPT_VERSIONS[ctx.task],
    contentTier,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap the caller's task-specific instructions in a clearly-labelled
 * task block so the model can distinguish task guidance from the
 * universal floor and venue voice.
 *
 * The contract / file-chat tasks also prepend the existing task-prompts-
 * sage scaffolds (TASK_CONTRACT_ANALYSIS, TASK_FILE_CHAT) so the same
 * disclaimers Sage already gives in chat carry over to contract-suite
 * and file-extraction surfaces.
 */
function composeTaskBlock(task: CouplePromptTask, taskInstructions: string): string {
  const trimmed = (taskInstructions ?? '').trim()
  switch (task) {
    case 'chat':
      // Chat callers (sage-brain) pass in getSageTaskPrompt(...) output
      // as taskInstructions. The persona scaffold is already inside that
      // string; we just frame it.
      return trimmed
    case 'contract_question':
      // Contract Q&A and contract analysis both reuse the existing Sage
      // contract-analysis scaffold so the lawyer disclaimer is always
      // present. The caller's specific instructions (Q&A vs analysis)
      // layer on after.
      return [
        '## TASK CONTEXT',
        TASK_CONTRACT_ANALYSIS,
        '',
        '### THIS REQUEST',
        trimmed,
      ].join('\n')
    case 'file_extraction':
      return [
        '## TASK CONTEXT',
        TASK_FILE_CHAT,
        '',
        '### THIS REQUEST',
        trimmed,
      ].join('\n')
    case 'event_feedback':
      // Coordinator-prepared draft for a public review. Sage's voice +
      // venue voice still apply because the couple may eventually read
      // this surface (it's published if it gets used as a public reply).
      return [
        '## TASK CONTEXT',
        'You are drafting a proactive response that the venue team can use if the couple posts a public review. Write in the venue\'s voice as configured above. Acknowledge specific positives. If issues are flagged, acknowledge them gracefully without being defensive. 150-250 words.',
        '',
        '### THIS REQUEST',
        trimmed,
      ].join('\n')
    case 'preview':
      // Public marketing-site preview — no auth, no wedding, no real
      // data. Voice + transparency rules still apply in full. The
      // caller passes the limited-access notes (cannot quote pricing /
      // availability / detailed policies) as taskInstructions.
      return [
        '## TASK CONTEXT',
        'You are answering a prospective couple in a public preview chat. You do not have access to specific pricing, availability, or detailed policies. Encourage them to book a tour or sign up for full access for those questions. Keep responses concise (2-3 sentences).',
        '',
        '### THIS REQUEST',
        trimmed,
      ].join('\n')
    case 'onboarding_test_draft':
      return [
        '## TASK CONTEXT',
        'You are drafting a sample inquiry response so the venue coordinator can preview how their configured AI voice will sound. Write a natural email (1-3 short paragraphs) using only the personality, KB, and rules above.',
        '',
        '### THIS REQUEST',
        trimmed,
      ].join('\n')
    default: {
      // Exhaustiveness guard — TS already enforces this, but the guard
      // keeps a runtime safety net if a new task is added without
      // updating the switch.
      const _exhaustive: never = task
      return _exhaustive
    }
  }
}

/**
 * Build the WEDDING CONTEXT block. Mirrors loadWeddingContext() in
 * brain/client.ts so the unified assembler matches the established
 * inquiry / client brain shape (date, guest count, status,
 * sage_context_notes, partner names, days-until). Reused across every
 * couple-facing surface that has a wedding linked.
 */
async function buildWeddingContextBlock(weddingId: string): Promise<string> {
  const supabase = createServiceClient()

  const { data: wedding } = await supabase
    .from('weddings')
    .select('wedding_date, guest_count_estimate, status, notes, sage_context_notes')
    .eq('id', weddingId)
    .maybeSingle()

  if (!wedding) return ''

  const parts: string[] = []
  if (wedding.wedding_date) parts.push(`Wedding date: ${wedding.wedding_date}`)
  if (wedding.guest_count_estimate) parts.push(`Guest count: ${wedding.guest_count_estimate}`)
  if (wedding.status) parts.push(`Status: ${wedding.status}`)
  if (wedding.notes) parts.push(`Notes: ${(wedding.notes as string).slice(0, 500)}`)

  // Coordinator brain-dump notes (last 14 days, newest first). These are
  // confidential signals — Sage acknowledges them without quoting verbatim.
  const rawNotes = wedding.sage_context_notes as Array<{
    body?: string
    added_at?: string
    source?: string
  }> | null
  if (Array.isArray(rawNotes) && rawNotes.length > 0) {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
    const recent = rawNotes
      .filter((n) => {
        const t = n.added_at ? new Date(n.added_at).getTime() : 0
        return t >= cutoff && typeof n.body === 'string' && n.body.trim().length > 0
      })
      .slice(-5)
      .reverse()
    if (recent.length > 0) {
      const body = recent.map((n) => `- ${(n.body as string).trim()}`).join('\n')
      parts.push(`Coordinator notes (recent, confidential, do not quote verbatim):\n${body}`)
    }
  }

  // Days until wedding — drives day-of mode + final-details mode framing.
  if (wedding.wedding_date) {
    const weddingDate = new Date(wedding.wedding_date as string)
    const now = new Date()
    const daysUntil = Math.ceil((weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    if (daysUntil <= 0) {
      parts.push('** WEDDING DAY OR PAST **')
    } else if (daysUntil <= 7) {
      parts.push(`** WEDDING IS IN ${daysUntil} DAYS, day-of mode **`)
    } else if (daysUntil <= 30) {
      parts.push(`** WEDDING IS IN ${daysUntil} DAYS, final details mode **`)
    } else {
      parts.push(`Days until wedding: ${daysUntil}`)
    }
  }

  // Partner names (deduped — see T5-Rixey-EEE Bug 1 in client.ts).
  const { data: people } = await supabase
    .from('people')
    .select('first_name, last_name, role')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2'])

  if (people && people.length > 0) {
    const names = dedupePeopleByName(people).map((p) => {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ')
      return `${name} (${p.role})`
    })
    parts.push(`Couple: ${names.join(' & ')}`)
  }

  if (parts.length === 0) return ''

  return `## WEDDING CONTEXT\n${parts.join('\n')}`
}

/**
 * Wrap the caller-provided document text in an explicitly-labelled file
 * context block. The COUPLE_RULES floor instructs the model to base
 * its document answers ONLY on this block, so the framing matters —
 * the marker sets the boundary the rule references.
 */
function buildFileContextBlock(fileContext: string): string {
  // Hard cap to keep system prompt within Anthropic's input budget on
  // long contracts. Callers already slice (couple/contracts callers
  // pass slice(0, 6000) / slice(0, 8000)); this is belt-and-braces.
  const MAX_CHARS = 12000
  const text = fileContext.length > MAX_CHARS
    ? `${fileContext.slice(0, MAX_CHARS)}\n\n[Truncated for length. Full text retained server-side.]`
    : fileContext

  return [
    '## ATTACHED FILE CONTEXT',
    'The user has attached a document. Base any document-specific answers on the text below. If the answer is not in the text, say so plainly.',
    '',
    text,
    '',
    '## END ATTACHED FILE CONTEXT',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Re-export for callers that need to substitute aiName into a Sage task
// prompt before passing it through as taskInstructions for task: 'chat'.
// ---------------------------------------------------------------------------

export { getSageTaskPrompt }
