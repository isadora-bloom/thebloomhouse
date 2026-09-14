import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { createServiceClient } from '@/lib/supabase/service'
import { parseInstagramFollowersText } from '@/lib/services/social/parsers/instagram-followers'
import { linkSocialEngagements } from '@/lib/services/identity/replay/social'
import { parseRelativeAge } from '@/lib/services/social/date-parser'
import {
  isSocialPlatform,
  isSocialMetricType,
  validateUploadedFile,
  extractRowsFromImages,
  MAX_IMAGES_PER_CAPTURE,
  type ParsedVisionRow,
  type ImageProcessResult,
  type InvalidVisionRow,
} from './screenshot'

/**
 * POST /api/intel/social-integration/capture
 *
 * Captures one snapshot of social engagement data, then routes every
 * parsed handle through `linkSignal` so it lands on the identity spine.
 * Two capture modes, same downstream path:
 *
 *   - application/json  -- text-paste. V1 only supports
 *     (platform=instagram, metric_type=new_followers); other combos
 *     return 422. Unchanged from wave 3.
 *   - multipart/form-data -- screenshot upload. NOVEMBER-PLAN.md wave 6
 *     (W41). One or more images (jpeg/png/webp, <=10 MB each) are
 *     resized (Sharp, max 2000px wide, WebP) and sent through
 *     `callAIVision` with the extraction prompt from vision-prompt.ts,
 *     one vision call per image. The model's rows are validated against
 *     `SocialVisionRow`'s shape (screenshot.ts) before anything is
 *     written. Screenshot mode is not limited to the text-paste V1
 *     combo -- the vision prompt already covers every (platform,
 *     metric_type) pair it defines, which is the whole point: story
 *     viewers and DM threads never render as copyable text, so a
 *     screenshot is the only way to capture them.
 *
 * Both modes insert into `social_captures` / `social_engagements` in
 * the same shape and call the same `linkSocialEngagements`, so W23's
 * adapter and `linkSignal` do the rest identically either way. The
 * uploaded image itself is never stored: `social_captures.source_text`
 * is set for a paste, left null for a screenshot, and
 * `source_image_path` is left null in both cases -- no storage bucket
 * is wired for social screenshots yet, and this route will not put a
 * raw image in the database to work around that. See PATCH NOTE at the
 * bottom of this file.
 *
 * Wave 3 (HANDLE-IDENTITY-SPEC.md §4): this route used to call
 * `matchEngagementsForCapture`, which bound handles straight to the
 * legacy `people` table by trigram name similarity and by "the email
 * local part contains the handle". Both were guesses and both auto-bound
 * strangers. They are gone. What comes back now is a spine outcome per
 * handle: attached to a couple, minted as a new one, a candidate in
 * review, or a fragment waiting for an identity.
 *
 * Body (application/json):
 *   { platform, metric_type, source_text }
 *
 * Body (multipart/form-data):
 *   { platform, metric_type, files: File[] }   -- one or more, field name "files"
 *
 * Response (200):
 *   {
 *     captureId, total, processed, skipped, skipped_reasons,
 *     attached, minted, candidates, fragments, duplicates,
 *     matched, unmatched,
 *     samples: [{handle, display_name, couple_id, couple_name,
 *                outcome, occurred_at, match_status}],
 *     images?: [{filename, ok, error?, rowCount, invalidCount, rejected?}],
 *     visionInvalid?: { count, samples: [{index, reason, handle_hint}] },
 *   }
 */
/** Screenshot captures per venue per hour. Each one can carry up to
 *  MAX_IMAGES_PER_CAPTURE images and each image is its own vision call, so
 *  20 is already a generous ceiling on a manual workflow. */
const CAPTURE_VISION_LIMIT = 20
const CAPTURE_VISION_WINDOW_SEC = 3600

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    // Spend guards (2026-09-14 security review, item 9). Screenshot mode is
    // the branch that costs money: one callAIVision per image, up to
    // MAX_IMAGES_PER_CAPTURE per request, and nothing bounded how often a
    // signed-in coordinator could fire it. The text-paste branch below is a
    // pure parse and is deliberately left alone — gating it on the cost
    // ceiling would stop a capture that spends nothing.
    const rl = await checkRateLimit({
      key: `social-capture-vision:${auth.venueId}`,
      limit: CAPTURE_VISION_LIMIT,
      windowSec: CAPTURE_VISION_WINDOW_SEC,
    })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many screenshot captures in a short window. Try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) } },
      )
    }
    const gate = await gateForBrainCall(auth.venueId)
    if (!gate.ok) {
      return NextResponse.json(
        {
          error:
            'AI spending is paused for this venue today. Screenshot capture resumes tomorrow; text paste still works.',
        },
        { status: 429 },
      )
    }
    return handleScreenshotCapture(request, auth.venueId, auth.isDemo ? null : auth.userId)
  }
  return handleTextPasteCapture(request, auth.venueId, auth.isDemo ? null : auth.userId)
}

// ---------------------------------------------------------------------------
// Text-paste mode (unchanged from wave 3, extracted into its own function
// so the route can dispatch on content-type)
// ---------------------------------------------------------------------------

async function handleTextPasteCapture(request: NextRequest, venueId: string, capturedBy: string | null) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }

  const platform = typeof body.platform === 'string' ? body.platform : ''
  const metricType = typeof body.metric_type === 'string' ? body.metric_type : ''
  const sourceText = typeof body.source_text === 'string' ? body.source_text : ''

  if (!platform || !metricType) {
    return badRequest('platform + metric_type required')
  }
  if (!isSocialPlatform(platform)) {
    return badRequest('unknown platform')
  }

  // V1 gate: the text-paste parser only exists for Instagram new
  // followers. Screenshot mode is not held to this gate -- see
  // handleScreenshotCapture.
  if (!(platform === 'instagram' && metricType === 'new_followers')) {
    return NextResponse.json(
      {
        error: 'metric_not_supported',
        message: `Text-paste capture for ${platform}/${metricType} is not supported. Try a screenshot instead.`,
      },
      { status: 422 },
    )
  }

  if (!sourceText.trim()) {
    return badRequest('source_text required for text-paste capture')
  }

  const service = createServiceClient()

  try {
    const parsed = parseInstagramFollowersText(sourceText)
    const parseResult = {
      parsed_count: parsed.length,
      unique_count: parsed.length, // parser already dedups
      parser_version: 'instagram-followers/v1',
      errors: [] as string[],
    }

    const { data: capture, error: capErr } = await service
      .from('social_captures')
      .insert({
        venue_id: venueId,
        platform,
        metric_type: metricType,
        captured_by: capturedBy,
        source_text: sourceText,
        source_image_path: null,
        parse_result: parseResult,
        total_handles: parsed.length,
        matched_count: 0,
        unmatched_count: 0,
      })
      .select('id, captured_at')
      .single()

    if (capErr || !capture) {
      return serverError(capErr ?? new Error('failed to insert capture'))
    }

    // A follower list carries no per-row timestamp, so engagement_at
    // starts as the capture time, which is a ceiling: the follow
    // happened at or before it.
    const engagementRows = parsed.map((p) => ({
      venue_id: venueId,
      social_capture_id: capture.id,
      platform,
      metric_type: metricType,
      handle: p.handle,
      display_name: p.display_name,
      engagement_at: capture.captured_at,
      match_status: 'pending' as const,
    }))

    if (engagementRows.length > 0) {
      const { error: engErr } = await service
        .from('social_engagements')
        .insert(engagementRows)
      if (engErr) {
        return serverError(engErr)
      }
    }

    const linked = await linkSocialEngagements({
      supabase: service,
      venueId,
      captureId: capture.id,
      source: 'social_capture',
    })

    return NextResponse.json({
      captureId: capture.id,
      total: parsed.length,
      processed: linked.processed,
      skipped: linked.skipped,
      skipped_reasons: linked.skipped_reasons,
      attached: linked.outcomes.attached,
      minted: linked.outcomes.minted,
      candidates: linked.outcomes.candidate_medium + linked.outcomes.candidate_low,
      fragments: linked.outcomes.fragment,
      duplicates: linked.outcomes.duplicate,
      matched: linked.matched,
      unmatched: linked.unmatched,
      samples: linked.samples,
      errors: linked.errors,
    })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// Screenshot mode (new, W41)
// ---------------------------------------------------------------------------

interface FileOutcome {
  filename: string
  ok: boolean
  error?: string
  rowCount: number
  invalidCount: number
  rejected?: 'file_too_large' | 'unsupported_type' | 'empty_file'
}

async function handleScreenshotCapture(request: NextRequest, venueId: string, capturedBy: string | null) {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return badRequest('Expected multipart/form-data')
  }

  const platform = String(formData.get('platform') ?? '')
  const metricType = String(formData.get('metric_type') ?? '')
  if (!platform || !metricType) {
    return badRequest('platform + metric_type required')
  }
  if (!isSocialPlatform(platform)) {
    return badRequest('unknown platform')
  }
  if (!isSocialMetricType(metricType)) {
    return badRequest('unknown metric_type')
  }

  const entries = formData.getAll('files')
  const files = entries.filter((e): e is File => e instanceof File)
  if (files.length === 0) {
    return badRequest('at least one image file is required (field "files")')
  }
  if (files.length > MAX_IMAGES_PER_CAPTURE) {
    return badRequest(`at most ${MAX_IMAGES_PER_CAPTURE} images per capture`)
  }

  const accepted: Array<{ buffer: Buffer; filename: string }> = []
  const rejected: FileOutcome[] = []
  for (const file of files) {
    const check = validateUploadedFile({ name: file.name, size: file.size, type: file.type })
    if (!check.ok) {
      rejected.push({
        filename: file.name || '(unnamed)',
        ok: false,
        rowCount: 0,
        invalidCount: 0,
        rejected: check.reason,
      })
      continue
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    accepted.push({ buffer, filename: file.name || '(unnamed)' })
  }

  const service = createServiceClient()

  try {
    let images: ImageProcessResult[] = []
    let visionRows: ParsedVisionRow[] = []
    let visionInvalid: InvalidVisionRow[] = []

    if (accepted.length > 0) {
      const extracted = await extractRowsFromImages({
        files: accepted,
        platform,
        metricType,
        venueId,
      })
      images = extracted.images
      visionRows = extracted.rows
      visionInvalid = extracted.invalidRows
    }

    const fileOutcomes: FileOutcome[] = [
      ...images.map((i) => ({
        filename: i.filename,
        ok: i.ok,
        error: i.error,
        rowCount: i.rows.length,
        invalidCount: i.invalidRows.length,
      })),
      ...rejected,
    ]

    const parseResult = {
      parsed_count: visionRows.length,
      unique_count: visionRows.length, // dedupVisionRows already dedups
      parser_version: 'social-vision-extract/v1',
      errors: rejected.map((r) => `${r.filename}: ${r.rejected}`),
      image_count: files.length,
      images: fileOutcomes,
    }

    // No storage bucket is wired for social-capture screenshots (see
    // PATCH NOTE). source_image_path stays null rather than pointing at
    // nothing, and the raw upload is never written anywhere -- it lived
    // in `accepted[].buffer` for the length of this request and is
    // discarded when the function returns.
    const { data: capture, error: capErr } = await service
      .from('social_captures')
      .insert({
        venue_id: venueId,
        platform,
        metric_type: metricType,
        captured_by: capturedBy,
        source_text: null,
        source_image_path: null,
        parse_result: parseResult,
        total_handles: visionRows.length,
        matched_count: 0,
        unmatched_count: 0,
      })
      .select('id, captured_at')
      .single()

    if (capErr || !capture) {
      return serverError(capErr ?? new Error('failed to insert capture'))
    }

    // Back-derive engagement_at from the screenshot's relative_age where
    // the model gave us one (date-parser.ts, anchored on the capture
    // instant so a replay months later derives the same value). Falls
    // back to the capture instant ceiling, same as the paste path.
    const engagementRows = visionRows.map((row) => {
      const derived = parseRelativeAge(row.relative_age, capture.captured_at)
      return {
        venue_id: venueId,
        social_capture_id: capture.id,
        platform,
        metric_type: metricType,
        handle: row.handle,
        display_name: row.display_name,
        engagement_at: derived?.occurred_at ?? capture.captured_at,
        match_status: 'pending' as const,
      }
    })

    if (engagementRows.length > 0) {
      const { error: engErr } = await service
        .from('social_engagements')
        .insert(engagementRows)
      if (engErr) {
        return serverError(engErr)
      }
    }

    // Exactly the same call the text-paste path makes -- same table
    // read-back, same shaping through buildSocialSignal, same
    // linkSignalBatch. A screenshot row and a pasted row are
    // indistinguishable from here on.
    const linked = await linkSocialEngagements({
      supabase: service,
      venueId,
      captureId: capture.id,
      source: 'social_capture',
    })

    return NextResponse.json({
      captureId: capture.id,
      total: visionRows.length,
      processed: linked.processed,
      skipped: linked.skipped,
      skipped_reasons: linked.skipped_reasons,
      attached: linked.outcomes.attached,
      minted: linked.outcomes.minted,
      candidates: linked.outcomes.candidate_medium + linked.outcomes.candidate_low,
      fragments: linked.outcomes.fragment,
      duplicates: linked.outcomes.duplicate,
      matched: linked.matched,
      unmatched: linked.unmatched,
      samples: linked.samples,
      errors: linked.errors,
      images: fileOutcomes,
      visionInvalid: {
        count: visionInvalid.length,
        samples: visionInvalid.slice(0, 3),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH NOTE (W41, NOVEMBER-PLAN.md wave 6)
// ---------------------------------------------------------------------------
// `social_captures.source_image_path` (migration 324) has carried the
// column since wave 3, with the comment "Storage path when the operator
// pasted/uploaded a screenshot instead of text ... V1.1 -- V1 leaves NULL."
// This IS V1.1, but no Supabase Storage bucket exists for social-capture
// screenshots (checked: venue-assets, couple-photos, brain-dump and the
// agency-documents bucket from migration 308 are all scoped to other
// features, not this one). Per the task brief for this workstream: if the
// storage path is not wired, store nothing and never put a raw image in
// the database. So this route resizes each upload, sends it to the vision
// model, and discards the buffer -- `source_image_path` stays null on
// every screenshot capture. Wiring a dedicated bucket (+ RLS policy, +
// migration) is a follow-up for whichever workstream owns a migration
// slot next; wave 6 was declared migration-free ("Dry work; no data
// needed") so it does not happen here.
