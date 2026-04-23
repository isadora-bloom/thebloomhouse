import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { classifyBrainDump, routeBrainDump } from '@/lib/services/brain-dump'
import {
  detectCsvShape,
  parseCsvRows,
  type ShapeDetection,
} from '@/lib/services/brain-dump-csv-shape'
import {
  importLeads,
  importReviews,
  importTourLinks,
  importPlatformActivity,
  type ImportSummary,
} from '@/lib/services/brain-dump-imports'
import { callAIVision, callAIJson } from '@/lib/ai/client'

const FILE_CONTENT_CAP = 40_000 // chars embedded into the classifier prompt
const LARGE_CSV_ROW_THRESHOLD = 50 // rows above this → preview + confirm

function extractAttachmentMeta(rawText: string): { name: string; type: string; path: string } | null {
  const match = rawText.match(/\[Attached file:\s*([^(]+?)\s*\(([^)]*)\)\s*stored at\s+([^\]]+)\]/)
  if (!match) return null
  return { name: match[1].trim(), type: match[2].trim(), path: match[3].trim() }
}

async function readAttachedFileText(
  supabase: ReturnType<typeof createServiceClient>,
  path: string
): Promise<string | null> {
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

async function readAttachedFileBase64(
  supabase: ReturnType<typeof createServiceClient>,
  path: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from('brain-dump').download(path)
    if (error || !data) return null
    const buf = Buffer.from(await data.arrayBuffer())
    return buf.toString('base64')
  } catch {
    return null
  }
}

interface VisionExtraction {
  intent: 'reviews' | 'storefront_analytics' | 'contract' | 'other'
  summary: string
  reviews?: Array<{ reviewer_name: string; rating: number; body: string; review_date?: string | null; source?: string }>
  analytics?: { source?: string; metric?: string; rows?: Array<{ label: string; value: number }> }
}

/**
 * Ask Claude vision to classify a screenshot and extract structured data.
 * The model has wide prior knowledge of The Knot, WeddingWire, Honeybook etc.
 * layouts, so we can ask for reviews or traffic charts directly.
 */
async function extractFromImage(args: {
  venueId: string
  fileName: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  base64: string
}): Promise<VisionExtraction | null> {
  const systemPrompt = `You are analysing a screenshot a wedding venue coordinator dropped into a capture tool. Return JSON matching exactly:
{
  "intent": "reviews" | "storefront_analytics" | "contract" | "other",
  "summary": "one sentence of what the screenshot shows",
  "reviews": [{"reviewer_name": "...", "rating": 1-5, "body": "full review text", "review_date": "YYYY-MM-DD or null", "source": "the_knot" | "wedding_wire" | "google" | "honeybook" | "other"}] or null,
  "analytics": {"source": "the_knot" | "wedding_wire" | "google" | "other", "metric": "unique_visitors" | "leads" | "spend" | "other", "rows": [{"label": "Oct", "value": 123}]} or null
}

Rules:
- reviews: a dashboard, page, or listing of testimonials. Extract every review visible — do not summarise or dedupe. Body should be the full review text as shown.
- storefront_analytics: a chart or table of traffic/leads/spend metrics. Extract every data point visible.
- contract: a PDF or image of a signed agreement. Do not extract; set summary and return.
- other: anything else. Set summary and return.

Respond with JSON only.`

  try {
    const response = await callAIVision({
      systemPrompt,
      userPrompt: `File name: ${args.fileName}. Classify and extract.`,
      imageBase64: args.base64,
      mediaType: args.mediaType,
      maxTokens: 2500,
      venueId: args.venueId,
      taskType: 'brain_dump_vision',
    })
    const cleaned = response.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    return JSON.parse(cleaned) as VisionExtraction
  } catch {
    return null
  }
}

/**
 * POST /api/brain-dump
 *
 * Universal coordinator-input endpoint. Flow:
 *   1. Persist the raw entry immediately (id returned even on later failure)
 *   2. If an attached file is a CSV → sniff headers via detectCsvShape
 *      - Known shape + small (<= LARGE_CSV_ROW_THRESHOLD rows) → import
 *        directly and return. No Claude call for obvious shapes.
 *      - Known shape + large → create a preview + confirm clarification
 *        so the coordinator confirms before 1000+ rows land.
 *      - Unknown shape → fall through to the classifier with CSV content
 *        embedded in the prompt (existing flow).
 *   3. If the attached file is an image → Claude vision extracts either
 *      a reviews array (routes to reviews + review_language mining) or
 *      an analytics chart (routes to source_attribution).
 *   4. Otherwise → existing Claude text classifier + routeBrainDump.
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
  if (!rawText) return NextResponse.json({ error: 'rawText is required' }, { status: 400 })
  if (rawText.length > 10_000) {
    return NextResponse.json({ error: 'rawText exceeds 10 KB cap' }, { status: 400 })
  }

  const inputType = (payload.inputType && ['text', 'voice', 'image', 'pdf', 'csv', 'mixed'].includes(payload.inputType))
    ? payload.inputType
    : 'text'

  const supabase = createServiceClient()

  // 1. Persist the raw entry so we have an id even if a later step fails.
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
    return NextResponse.json({ error: insertErr?.message ?? 'Failed to record entry' }, { status: 500 })
  }

  const attachment = extractAttachmentMeta(rawText)

  // 2. CSV fast path — sniff headers and short-circuit obvious shapes.
  if (attachment && (attachment.type === 'text/csv' || attachment.name.toLowerCase().endsWith('.csv'))) {
    const fileText = await readAttachedFileText(supabase, attachment.path)
    if (fileText) {
      const rows = parseCsvRows(fileText)
      const headerRow = rows[0] ?? []
      const dataRows = rows.slice(1)
      const detection = detectCsvShape(headerRow)

      // Direct-import paths (confidence >= 70).
      if (detection.confidence >= 70 && detection.shape !== 'unknown') {
        // Large CSVs always go through confirm-first per the Phase 2.5 spec.
        if (dataRows.length > LARGE_CSV_ROW_THRESHOLD) {
          const q = `This looks like ${humanShape(detection.shape)} data with ${dataRows.length} rows. Confirm the import from the Notifications page.`
          await supabase.from('brain_dump_entries').update({
            parse_status: 'needs_clarification',
            clarification_question: q,
            parse_result: { shape: detection.shape, columns: detection.columns, rowCount: dataRows.length, storagePath: attachment.path },
            parsed_at: new Date().toISOString(),
          }).eq('id', entry.id)
          return NextResponse.json({
            entryId: entry.id,
            intent: `${detection.shape}_preview`,
            confidence: detection.confidence,
            needsClarification: true,
            clarificationQuestion: q,
            previewRows: dataRows.length,
          })
        }

        // Small CSVs with a known shape: import directly.
        const summary = await runCsvImport({
          supabase,
          venueId: auth.venueId,
          detection,
          headerRow,
          dataRows,
        })
        await supabase.from('brain_dump_entries').update({
          parse_status: 'confirmed',
          parse_result: { shape: detection.shape, summary },
          routed_to: [{ table: routedTable(detection.shape), action: `direct_import:${summary.inserted}`, id: null }],
          parsed_at: new Date().toISOString(),
          resolved_at: new Date().toISOString(),
        }).eq('id', entry.id)
        return NextResponse.json({
          entryId: entry.id,
          intent: detection.shape,
          confidence: detection.confidence,
          needsClarification: false,
          importSummary: summary,
          routedTo: [{ table: routedTable(detection.shape), action: `direct_import:${summary.inserted}`, id: null }],
        })
      }

      // Unknown shape — embed the content into the classifier prompt.
      return runClassifierFallback({
        supabase, auth, entry, rawText, fileText, attachmentName: attachment.name,
      })
    }
  }

  // 3. Image fast path — vision extraction.
  if (attachment && attachment.type.startsWith('image/')) {
    const b64 = await readAttachedFileBase64(supabase, attachment.path)
    if (b64) {
      const mt = attachment.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
      const v = await extractFromImage({
        venueId: auth.venueId,
        fileName: attachment.name,
        mediaType: mt,
        base64: b64,
      })
      if (v) {
        if (v.intent === 'reviews' && v.reviews && v.reviews.length > 0) {
          const summary = await importReviews({
            supabase,
            venueId: auth.venueId,
            rows: v.reviews.map((r) => ({
              source: (r.source ?? 'other').toLowerCase(),
              reviewer_name: r.reviewer_name,
              rating: r.rating,
              body: r.body,
              review_date: r.review_date ?? null,
            })),
          })
          await supabase.from('brain_dump_entries').update({
            parse_status: 'confirmed',
            parse_result: { vision: v, summary },
            routed_to: [{ table: 'reviews', action: `vision_import:${summary.inserted}`, id: null }],
            parsed_at: new Date().toISOString(),
            resolved_at: new Date().toISOString(),
          }).eq('id', entry.id)
          return NextResponse.json({
            entryId: entry.id,
            intent: 'reviews_from_screenshot',
            confidence: 85,
            needsClarification: false,
            importSummary: summary,
          })
        }

        if (v.intent === 'storefront_analytics' && v.analytics?.rows?.length) {
          // Park as a needs_clarification preview — analytics imports
          // always preview-and-confirm per the Phase 2.5 CSV rule, and
          // storefront visitor counts require the coordinator to pick a
          // period (monthly vs weekly) before it lands.
          const q = `Screenshot parsed as ${v.analytics.source ?? 'platform'} ${v.analytics.metric ?? 'metrics'} with ${v.analytics.rows.length} data points. Confirm from the Notifications page.`
          await supabase.from('brain_dump_entries').update({
            parse_status: 'needs_clarification',
            clarification_question: q,
            parse_result: { vision: v },
            parsed_at: new Date().toISOString(),
          }).eq('id', entry.id)
          return NextResponse.json({
            entryId: entry.id,
            intent: 'storefront_analytics_preview',
            confidence: 75,
            needsClarification: true,
            clarificationQuestion: q,
          })
        }

        // Other image types: store vision summary, park for triage.
        await supabase.from('brain_dump_entries').update({
          parse_status: 'needs_clarification',
          clarification_question: v.summary ?? 'Image attached — what should I do with it?',
          parse_result: { vision: v },
          parsed_at: new Date().toISOString(),
        }).eq('id', entry.id)
        return NextResponse.json({
          entryId: entry.id,
          intent: v.intent,
          confidence: 50,
          needsClarification: true,
          clarificationQuestion: v.summary ?? null,
        })
      }
    }
  }

  // 4. Fall back to the existing Claude text classifier.
  let classifierText = rawText
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
  }

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanShape(shape: ShapeDetection['shape']): string {
  switch (shape) {
    case 'leads': return 'leads / CRM'
    case 'knowledge_base_qa': return 'FAQ Q/A'
    case 'knowledge_base_tc': return 'knowledge base (title/content)'
    case 'tour_links': return 'tour booking links'
    case 'platform_activity': return 'storefront visitor activity'
    case 'reviews': return 'reviews'
    case 'marketing_spend': return 'marketing spend'
    default: return shape
  }
}

function routedTable(shape: ShapeDetection['shape']): string {
  switch (shape) {
    case 'leads': return 'weddings+people+interactions'
    case 'knowledge_base_qa':
    case 'knowledge_base_tc': return 'knowledge_base'
    case 'tour_links': return 'venue_ai_config'
    case 'platform_activity': return 'engagement_events'
    case 'reviews': return 'reviews'
    case 'marketing_spend': return 'marketing_spend'
    default: return 'unknown'
  }
}

/**
 * Fan the detected shape into the right import function. Exported so
 * the preview-confirm endpoint can re-run it on user confirmation.
 */
export async function runCsvImport(args: {
  supabase: ReturnType<typeof createServiceClient>
  venueId: string
  detection: ShapeDetection
  headerRow: string[]
  dataRows: string[][]
}): Promise<ImportSummary> {
  const { supabase, venueId, detection, headerRow, dataRows } = args
  const { rowToRecord } = await import('@/lib/services/brain-dump-csv-shape')

  switch (detection.shape) {
    case 'leads':
      return importLeads({ supabase, venueId, detection, headerRow, dataRows })
    case 'tour_links': {
      const rows = dataRows.map((r) => rowToRecord(detection, headerRow, r)).filter((r) => r.label && r.url)
      return importTourLinks({
        supabase, venueId,
        rows: rows.map((r) => ({
          label: r.label as string,
          url: r.url as string,
          audience: r.audience,
          description: r.description,
        })),
      })
    }
    case 'platform_activity':
      return importPlatformActivity({ supabase, venueId, detection, headerRow, dataRows, sourceHint: 'wedding_wire' })
    case 'reviews': {
      const rows = dataRows.map((r) => rowToRecord(detection, headerRow, r))
        .filter((r) => r.reviewer && r.body)
        .map((r) => ({
          source: (r.source ?? 'csv_import').toLowerCase(),
          reviewer_name: r.reviewer as string,
          rating: Number(r.rating) || 5,
          body: r.body as string,
          review_date: r.date ?? null,
          title: r.title ?? null,
        }))
      return importReviews({ supabase, venueId, rows })
    }
    case 'knowledge_base_qa':
    case 'knowledge_base_tc': {
      const rows = dataRows.map((r) => rowToRecord(detection, headerRow, r))
        .filter((r) => r.question && r.answer)
        .map((r) => ({
          venue_id: venueId,
          question: r.question as string,
          answer: r.answer as string,
          category: (r.category ?? 'general').toString().toLowerCase().slice(0, 40),
          priority: 50,
          is_active: true,
          source: 'csv',
        }))
      const { data: existing } = await supabase
        .from('knowledge_base')
        .select('question')
        .eq('venue_id', venueId)
        .in('question', rows.map((r) => r.question))
      const exSet = new Set((existing ?? []).map((e) => e.question as string))
      const toInsert = rows.filter((r) => !exSet.has(r.question))
      if (toInsert.length > 0) {
        const { error } = await supabase.from('knowledge_base').insert(toInsert)
        if (error) return { inserted: 0, updated: 0, skipped: 0, errors: [error.message] }
      }
      return { inserted: toInsert.length, updated: 0, skipped: rows.length - toInsert.length, errors: [] }
    }
    default:
      return { inserted: 0, updated: 0, skipped: 0, errors: ['unknown shape'] }
  }
}

/**
 * Fallback path — CSV was detected but shape is unknown. Embed content
 * in the classifier prompt and let Claude figure it out.
 */
async function runClassifierFallback(args: {
  supabase: ReturnType<typeof createServiceClient>
  auth: { venueId: string; userId: string }
  entry: { id: string }
  rawText: string
  fileText: string
  attachmentName: string
}) {
  const { supabase, auth, entry, rawText, fileText, attachmentName } = args
  const classifierText = `${rawText}\n\n--- ATTACHED FILE CONTENT (${attachmentName}) ---\n${fileText}\n--- END ATTACHED FILE ---`
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
    await supabase.from('brain_dump_entries').update({
      parse_status: 'needs_clarification',
      clarification_question: `AI classifier failed: ${message}. Please triage manually.`,
      parsed_at: new Date().toISOString(),
    }).eq('id', entry.id)
    return NextResponse.json({
      entryId: entry.id,
      needsClarification: true,
      clarificationQuestion: `AI classifier failed: ${message}.`,
      error: message,
    }, { status: 200 })
  }
}

// Keep unused Claude JSON helper importable so TS doesn't prune it from
// the tree if a future caller needs it.
void callAIJson
