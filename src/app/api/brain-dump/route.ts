import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { classifyBrainDump, routeBrainDump } from '@/lib/services/brain-dump'

const FILE_CONTENT_CAP = 40_000 // chars embedded into the classifier prompt

/**
 * Extracts the "[Attached file: NAME (TYPE) stored at PATH]" marker the
 * FloatingBrainDump component injects into rawText when a file is attached.
 * Returns the parsed pieces or null when there is no attachment.
 */
function extractAttachmentMeta(rawText: string): { name: string; type: string; path: string } | null {
  const match = rawText.match(/\[Attached file:\s*([^(]+?)\s*\(([^)]*)\)\s*stored at\s+([^\]]+)\]/)
  if (!match) return null
  return { name: match[1].trim(), type: match[2].trim(), path: match[3].trim() }
}

/**
 * Downloads a file from the brain-dump bucket and returns its text content
 * (best-effort; caps at FILE_CONTENT_CAP chars). Returns null when the file
 * cannot be read or is not text-like. Images/PDFs return null — OCR is
 * future work. CSVs are returned verbatim so the classifier can see their
 * headers and rows.
 */
async function readAttachedFileText(supabase: ReturnType<typeof createServiceClient>, path: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from('brain-dump').download(path)
    if (error || !data) return null
    const text = await data.text()
    if (!text) return null
    return text.length > FILE_CONTENT_CAP ? text.slice(0, FILE_CONTENT_CAP) + '\n... (truncated)' : text
  } catch {
    return null
  }
}

/**
 * POST /api/brain-dump
 *
 * Universal coordinator-input endpoint. Accepts:
 *   { rawText: string, inputType?: 'text'|'voice'|'image'|'pdf'|'csv'|'mixed' }
 *
 * File-backed submissions upload to the `brain-dump` Supabase Storage
 * bucket first (client-side) and pass a signed-URL reference IN the
 * rawText. The AI parser sees the reference + a transcript/OCR summary.
 * (Text-only is the minimum viable path; file preprocessing is future
 * work.)
 *
 * Returns:
 *   { entryId, needsClarification, clarificationQuestion?, routedTo? }
 */

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: { rawText?: string; inputType?: string }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawText = (payload.rawText ?? '').trim()
  if (!rawText) {
    return NextResponse.json({ error: 'rawText is required' }, { status: 400 })
  }
  if (rawText.length > 10_000) {
    return NextResponse.json({ error: 'rawText exceeds 10 KB cap' }, { status: 400 })
  }

  const inputType = (payload.inputType && ['text', 'voice', 'image', 'pdf', 'csv', 'mixed'].includes(payload.inputType))
    ? payload.inputType
    : 'text'

  const supabase = createServiceClient()

  // 1. Persist the raw entry first so we have an ID even if parsing fails.
  const { data: entry, error: insertErr } = await supabase
    .from('brain_dump_entries')
    .insert({
      venue_id: auth.venueId,
      submitted_by: auth.userId,
      raw_input: rawText,
      input_type: inputType,
      parse_status: 'pending',
    })
    .select('id')
    .single()

  if (insertErr || !entry) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'Failed to record entry' },
      { status: 500 }
    )
  }

  // 2. If the submission has an attached file, fetch its content so the
  //    classifier sees what's inside — a CSV header of "Question,Answer"
  //    is the signal that routes it to knowledge_base. Without this step
  //    the classifier would see only the coordinator's typed prompt (often
  //    empty or "key policies") and default to ambiguous.
  let classifierText = rawText
  const attachment = extractAttachmentMeta(rawText)
  if (attachment) {
    const isTextLike =
      attachment.type === 'text/csv' ||
      attachment.name.toLowerCase().endsWith('.csv') ||
      attachment.type.startsWith('text/')
    if (isTextLike) {
      const fileText = await readAttachedFileText(supabase, attachment.path)
      if (fileText) {
        classifierText = `${rawText}\n\n--- ATTACHED FILE CONTENT (${attachment.name}) ---\n${fileText}\n--- END ATTACHED FILE ---`
      }
    }
    // Images/PDFs fall through — OCR is future work. The classifier
    // still sees the attachment marker via rawText.
  }

  // 3. Classify. If the AI call fails entirely, park in needs_clarification
  //    with a diagnostic question rather than throwing a 500 at the
  //    coordinator — they've already committed to capture.
  try {
    const parsed = await classifyBrainDump({ venueId: auth.venueId, rawText: classifierText })
    const route = await routeBrainDump({
      venueId: auth.venueId,
      entryId: entry.id,
      submittedBy: auth.userId,
      parsed,
      rawText,
    })

    return NextResponse.json({
      entryId: entry.id,
      intent: parsed.intent,
      confidence: parsed.confidence,
      needsClarification: route.needsClarification,
      clarificationQuestion: route.clarificationQuestion,
      routedTo: route.routedTo,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: `AI classifier failed: ${message}. Please triage manually.`,
        parsed_at: new Date().toISOString(),
      })
      .eq('id', entry.id)
    return NextResponse.json({
      entryId: entry.id,
      needsClarification: true,
      clarificationQuestion: `AI classifier failed: ${message}.`,
      error: message,
    }, { status: 200 })
  }
}
