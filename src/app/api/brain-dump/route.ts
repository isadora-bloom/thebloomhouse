import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { classifyBrainDump, routeBrainDump } from '@/lib/services/brain-dump'

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

  // 2. Classify. If the AI call fails entirely, park in needs_clarification
  //    with a diagnostic question rather than throwing a 500 at the
  //    coordinator — they've already committed to capture.
  try {
    const parsed = await classifyBrainDump({ venueId: auth.venueId, rawText })
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
