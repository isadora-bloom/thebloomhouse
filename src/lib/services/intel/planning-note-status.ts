/**
 * Provenance of a `planning_notes` row, carried on its `status` column.
 *
 * 2026-09-14 ingestion audit item 7. AI-derived planning notes are a
 * claim a model made after reading somebody else's message. They land on
 * a coordinator surface next to notes a human typed, and until now
 * nothing on the row said which was which.
 *
 * `status` is the column that carries it. `planning_notes` has no
 * `source` column and this workstream does not own migrations; `status`
 * already means "how settled is this row", which is the same question.
 *
 * This module holds nothing but constants so client components can import
 * it. `planning-extraction.ts` pulls in the Supabase service client at
 * module scope and must not be imported into a 'use client' bundle.
 */

export type PlanningNoteSource = 'ai_extracted' | 'regex' | 'contract'

/** The `planning_notes.status` value each provenance writes. */
export const PLANNING_NOTE_STATUS_BY_SOURCE: Record<PlanningNoteSource, string> = {
  ai_extracted: 'ai_extracted',
  regex: 'pending',
  contract: 'extracted',
}

/**
 * Statuses meaning "a model or a pattern said this and no human has
 * agreed yet". The coordinator surfaces label these as unconfirmed.
 */
export const UNCONFIRMED_PLANNING_NOTE_STATUSES: ReadonlySet<string> = new Set([
  'ai_extracted',
  'pending',
])
