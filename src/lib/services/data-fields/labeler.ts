/**
 * Unmapped-field labeler.
 *
 * When imported data carries a column Bloom has no typed field for,
 * the column key + its values sit in a raw jsonb (raw_import_row /
 * extra_fields). This service asks an LLM to RECOGNISE what each
 * un-homed column most likely is — a human label, a data type, and a
 * one-line read of the data.
 *
 * Hard rule (operator stated): recognise-and-propose, never
 * recognise-and-silently-write. The output of this service is a
 * SUGGESTION shown to the operator on the data-fields page. Nothing
 * is written to a typed column on the strength of an LLM guess — the
 * operator confirms (or edits, or ignores) before a tracked_data_fields
 * definition is created.
 */

import { callAIJson } from '@/lib/ai/client'

export const FIELD_LABELER_PROMPT_VERSION = 'data-field-labeler.v1'

export interface UnmappedKeyInput {
  /** The raw column key, verbatim from the source export. */
  key: string
  /** A few example values seen for this key (deduped, trimmed). */
  samples: string[]
}

export interface FieldSuggestion {
  key: string
  /** Short human label, e.g. "Bar Package", "Anniversary date". */
  suggested_label: string
  /** One of the tracked_data_fields data_type values. */
  suggested_type: 'text' | 'number' | 'money' | 'date' | 'boolean'
  /** One sentence: what this column most likely holds. */
  what_it_looks_like: string
}

const SYSTEM_PROMPT = `You are labeling spreadsheet columns a wedding venue imported into their software. Each column has a key (the header from their export) and a few sample values. The software has no built-in field for these columns, so a human operator needs to decide what to do with each one.

For EACH column, return:
- suggested_label: a short, human, Title Case label (e.g. "Bar Package", "Anniversary Date", "Planner Name"). Not the raw key — a clean label.
- suggested_type: one of "text", "number", "money", "date", "boolean". Pick "money" for currency amounts, "date" for dates, "number" for plain counts/integers, "boolean" for yes/no, "text" otherwise.
- what_it_looks_like: ONE sentence describing what the column most likely holds, written for the venue operator.

Be honest when a column is ambiguous — say so in what_it_looks_like rather than inventing a confident label. Do not guess a meaning that the key and samples do not support.

Return ONLY this JSON:
{ "fields": [ { "key": "...", "suggested_label": "...", "suggested_type": "...", "what_it_looks_like": "..." } ] }`

interface RawResponse {
  fields?: Array<{
    key?: unknown
    suggested_label?: unknown
    suggested_type?: unknown
    what_it_looks_like?: unknown
  }>
}

const VALID_TYPES = new Set(['text', 'number', 'money', 'date', 'boolean'])

/**
 * Label a batch of unmapped keys. Never throws — on any failure it
 * returns a plain fallback suggestion per key (label = key, type =
 * text) so the data-fields page still renders.
 */
export async function labelUnmappedFields(
  venueId: string,
  keys: UnmappedKeyInput[],
): Promise<FieldSuggestion[]> {
  if (keys.length === 0) return []

  const fallback = (): FieldSuggestion[] =>
    keys.map((k) => ({
      key: k.key,
      suggested_label: k.key,
      suggested_type: 'text',
      what_it_looks_like: 'Not yet classified — label this field manually.',
    }))

  const userPrompt = keys
    .map(
      (k) =>
        `COLUMN: ${k.key}\n  samples: ${k.samples.slice(0, 5).map((s) => JSON.stringify(s)).join(', ') || '(none)'}`,
    )
    .join('\n\n')

  try {
    const raw = await callAIJson<RawResponse>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 1500,
      temperature: 0.1,
      venueId,
      taskType: 'data_field_labeler',
      tier: 'haiku',
      promptVersion: FIELD_LABELER_PROMPT_VERSION,
    })
    const byKey = new Map<string, FieldSuggestion>()
    for (const f of raw.fields ?? []) {
      const key = typeof f.key === 'string' ? f.key : null
      if (!key) continue
      const type =
        typeof f.suggested_type === 'string' && VALID_TYPES.has(f.suggested_type)
          ? (f.suggested_type as FieldSuggestion['suggested_type'])
          : 'text'
      byKey.set(key, {
        key,
        suggested_label:
          typeof f.suggested_label === 'string' && f.suggested_label.trim()
            ? f.suggested_label.trim().slice(0, 80)
            : key,
        suggested_type: type,
        what_it_looks_like:
          typeof f.what_it_looks_like === 'string'
            ? f.what_it_looks_like.trim().slice(0, 240)
            : '',
      })
    }
    // Any key the model skipped falls back to a plain suggestion.
    return keys.map(
      (k) =>
        byKey.get(k.key) ?? {
          key: k.key,
          suggested_label: k.key,
          suggested_type: 'text' as const,
          what_it_looks_like: 'Not classified by the model — label manually.',
        },
    )
  } catch {
    return fallback()
  }
}
