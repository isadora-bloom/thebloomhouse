/**
 * Screenshot capture for /api/intel/social-integration/capture.
 *
 * NOVEMBER-PLAN.md wave 6, W41. The text-paste path
 * (`parseInstagramFollowersText`) only works because Instagram's web UI
 * lets an operator copy a followers list as text. Story viewers and DM
 * threads never render as copyable text — the only way to capture them
 * is a screenshot. `vision-prompt.ts` (HANDLE-IDENTITY-SPEC.md §4) has
 * carried the extraction prompt since wave 3; nothing called it until
 * now.
 *
 * This module owns everything between "an uploaded file" and "a row
 * shaped like the text-paste parser's output": size/type validation,
 * the Sharp resize (never send a raw screenshot to the model or store
 * one), the vision call, and validating the model's JSON reply against
 * `SocialVisionRow`'s shape. What comes out (`ParsedVisionRow[]`) is
 * deliberately the same shape `parseInstagramFollowersText` returns
 * (`handle`, `display_name`) plus the two fields only a screenshot can
 * carry (`relative_age`, `vision_action`) -- the capture route folds
 * both sources into the same `social_engagements` insert and the same
 * call to `linkSocialEngagements`, so W23's adapter and `linkSignal` do
 * the rest exactly as they do for a paste.
 *
 * Image-upload rule (CLAUDE.md / repo doctrine): never read a raw image
 * into a prompt at full size. Every buffer that reaches `callAIVision`
 * here has already gone through `resizeImageForVision` -- bounded
 * width, WebP, bounded quality. The original upload never touches
 * disk, the database, or `api_costs`; it lives in memory for the
 * length of one request and is discarded.
 */

import sharp from 'sharp'
import { callAIVision } from '@/lib/ai/client'
import {
  buildSocialVisionSystemPrompt,
  buildSocialVisionUserPrompt,
  SOCIAL_VISION_PROMPT_VERSION,
  type SocialPlatform,
  type SocialMetricType,
} from '@/lib/services/social/vision-prompt'

// ---------------------------------------------------------------------------
// Vocabulary -- mirrors the unions exported from vision-prompt.ts. That file
// is call-only for this workstream (owned by W23/wave 3), so the runtime
// list lives here rather than as an export added to it.
// ---------------------------------------------------------------------------

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  'instagram',
  'tiktok',
  'facebook',
  'pinterest',
]

export const SOCIAL_METRIC_TYPES: readonly SocialMetricType[] = [
  'new_followers',
  'profile_visits',
  'story_views',
  'post_engagement',
  'dms',
  'video_engagement',
  'page_likes',
  'saves',
  'board_follows',
]

export function isSocialPlatform(value: string): value is SocialPlatform {
  return (SOCIAL_PLATFORMS as readonly string[]).includes(value)
}

export function isSocialMetricType(value: string): value is SocialMetricType {
  return (SOCIAL_METRIC_TYPES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Upload limits
// ---------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB, per spec
export const MAX_IMAGES_PER_CAPTURE = 6
export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number]

export const RESIZE_MAX_WIDTH = 2000
export const RESIZE_WEBP_QUALITY = 82

export interface UploadedFileLike {
  name: string
  size: number
  type: string
}

export type FileRejectionReason = 'file_too_large' | 'unsupported_type' | 'empty_file'

/**
 * Pure size/type gate, checked before a file is ever read into memory.
 * A pure function of {name, size, type} so a test can drive it without a
 * real `File`/`FormData`.
 */
export function validateUploadedFile(
  file: UploadedFileLike,
): { ok: true } | { ok: false; reason: FileRejectionReason } {
  if (!file.size || file.size <= 0) return { ok: false, reason: 'empty_file' }
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'file_too_large' }
  const type = (file.type || '').toLowerCase()
  if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'unsupported_type' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Row validation -- the model's JSON array against SocialVisionRow's shape.
// ---------------------------------------------------------------------------

/** What a validated vision row becomes. Same two fields the text-paste
 *  parser produces (`handle`, `display_name`), plus the two only a
 *  screenshot carries. */
export interface ParsedVisionRow {
  handle: string
  display_name: string | null
  relative_age: string | null
  vision_action: string | null
}

export interface InvalidVisionRow {
  index: number
  reason: string
  /** Best-effort handle string for display, even on a row that failed
   *  validation -- "row 4 (@rosie...)" reads better than "row 4". */
  handle_hint: string | null
}

const MAX_HANDLE_LEN = 60
const MAX_DISPLAY_NAME_LEN = 200
const MAX_ACTION_LEN = 60
const MAX_RELATIVE_AGE_LEN = 40

/** Validates one row from the model's JSON array against the
 *  `SocialVisionRow` contract (vision-prompt.ts). Never throws --
 *  returns a typed rejection so the route can report the reason
 *  instead of silently dropping the row. */
export function validateVisionRow(
  raw: unknown,
  index: number,
): { ok: true; row: ParsedVisionRow } | { ok: false; error: InvalidVisionRow } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { index, reason: 'row is not an object', handle_hint: null } }
  }
  const r = raw as Record<string, unknown>

  const handleRaw = typeof r.handle === 'string' ? r.handle.trim() : ''
  const handle = handleRaw.replace(/^@/, '').toLowerCase()
  if (!handle) {
    return { ok: false, error: { index, reason: 'missing or empty handle', handle_hint: null } }
  }
  if (handle.length > MAX_HANDLE_LEN) {
    return {
      ok: false,
      error: { index, reason: 'handle implausibly long', handle_hint: handle.slice(0, MAX_HANDLE_LEN) },
    }
  }
  // Handles never contain whitespace once normalised. A row that still
  // has a space after stripping "@" is not a real handle -- the model
  // likely echoed a UI label instead of skipping it.
  if (/\s/.test(handle)) {
    return { ok: false, error: { index, reason: 'handle contains whitespace', handle_hint: handle } }
  }

  if (typeof r.action !== 'string' || !r.action.trim()) {
    return { ok: false, error: { index, reason: 'missing action', handle_hint: handle } }
  }
  const action = r.action.trim().toLowerCase().slice(0, MAX_ACTION_LEN)

  const display_name =
    typeof r.display_name === 'string' && r.display_name.trim()
      ? r.display_name.trim().slice(0, MAX_DISPLAY_NAME_LEN)
      : null

  const relative_age =
    typeof r.relative_age === 'string' && r.relative_age.trim()
      ? r.relative_age.trim().slice(0, MAX_RELATIVE_AGE_LEN)
      : null

  if (r.status !== undefined && r.status !== null && !['mutual', 'not_following_back'].includes(String(r.status))) {
    return { ok: false, error: { index, reason: 'status not one of the allowed values', handle_hint: handle } }
  }

  return { ok: true, row: { handle, display_name, relative_age, vision_action: action } }
}

export interface VisionRowValidationResult {
  rows: ParsedVisionRow[]
  invalid: InvalidVisionRow[]
}

/** Validates the whole JSON value the model returned. Handles the "not
 *  even an array" case as one invalid entry rather than throwing. */
export function validateVisionRows(raw: unknown): VisionRowValidationResult {
  if (!Array.isArray(raw)) {
    return {
      rows: [],
      invalid: [{ index: -1, reason: 'model did not return a JSON array', handle_hint: null }],
    }
  }
  const rows: ParsedVisionRow[] = []
  const invalid: InvalidVisionRow[] = []
  raw.forEach((entry, index) => {
    const outcome = validateVisionRow(entry, index)
    if (outcome.ok) rows.push(outcome.row)
    else invalid.push(outcome.error)
  })
  return { rows, invalid }
}

/** Dedup by handle within one capture, first occurrence wins -- the
 *  same convention `parseInstagramFollowersText` uses, and the one
 *  `vision-prompt.ts` explicitly hands off to "downstream code". Two
 *  screenshots of an overlapping scroll position must not mint two
 *  engagement rows for the same handle. */
export function dedupVisionRows(rows: ParsedVisionRow[]): ParsedVisionRow[] {
  const seen = new Set<string>()
  const out: ParsedVisionRow[] = []
  for (const row of rows) {
    if (seen.has(row.handle)) continue
    seen.add(row.handle)
    out.push(row)
  }
  return out
}

// ---------------------------------------------------------------------------
// Resize -- Sharp, bounded width, WebP. Runs before every vision call and
// before anything is ever considered for storage.
// ---------------------------------------------------------------------------

export async function resizeImageForVision(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate() // respect EXIF orientation before measuring width
    .resize({ width: RESIZE_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: RESIZE_WEBP_QUALITY })
    .toBuffer()
}

// ---------------------------------------------------------------------------
// One image, one vision call
// ---------------------------------------------------------------------------

/** Matches the slice of `callAIVision`'s contract this module needs.
 *  Injectable so a test can stub the model without a network call or an
 *  API key. Defaults to the real client. */
export type VisionCaller = (args: {
  systemPrompt: string
  userPrompt: string
  imageBase64: string
  mediaType: 'image/webp'
  maxTokens?: number
  venueId?: string
  taskType?: string
  promptVersion?: string
  correlationId?: string
}) => Promise<{ text: string }>

export interface ImageProcessResult {
  filename: string
  /** false only when the image itself could not be read/resized or the
   *  vision call failed outright -- a model reply with zero usable rows
   *  is still `ok: true` with an empty `rows` array. */
  ok: boolean
  error?: string
  rows: ParsedVisionRow[]
  invalidRows: InvalidVisionRow[]
}

export interface ExtractRowsFromImageArgs {
  buffer: Buffer
  filename: string
  platform: SocialPlatform
  metricType: SocialMetricType
  venueId: string
  taskType?: string
  correlationId?: string
  callVision?: VisionCaller
}

const defaultVisionCaller: VisionCaller = (args) => callAIVision(args)

/**
 * Resize, call vision once, validate the reply. One call in, one
 * `ImageProcessResult` out -- never throws; a failure at any stage
 * becomes `ok: false` with a message so the capture route can report it
 * per-file rather than aborting the whole batch.
 */
export async function extractRowsFromImage(
  args: ExtractRowsFromImageArgs,
): Promise<ImageProcessResult> {
  const callVision = args.callVision ?? defaultVisionCaller

  let resized: Buffer
  try {
    resized = await resizeImageForVision(args.buffer)
  } catch (err) {
    return {
      filename: args.filename,
      ok: false,
      error: `could not read image: ${(err as Error).message}`,
      rows: [],
      invalidRows: [],
    }
  }

  const base64 = resized.toString('base64')

  let text: string
  try {
    const result = await callVision({
      systemPrompt: buildSocialVisionSystemPrompt(),
      userPrompt: buildSocialVisionUserPrompt({ platform: args.platform, metricType: args.metricType }),
      imageBase64: base64,
      mediaType: 'image/webp',
      maxTokens: 2000,
      venueId: args.venueId,
      taskType: args.taskType ?? 'social_vision_capture',
      promptVersion: SOCIAL_VISION_PROMPT_VERSION,
      correlationId: args.correlationId,
    })
    text = result.text
  } catch (err) {
    return {
      filename: args.filename,
      ok: false,
      error: `vision call failed: ${(err as Error).message}`,
      rows: [],
      invalidRows: [],
    }
  }

  let parsed: unknown
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return {
      filename: args.filename,
      ok: false,
      error: 'model did not return valid JSON',
      rows: [],
      invalidRows: [],
    }
  }

  const { rows, invalid } = validateVisionRows(parsed)
  return { filename: args.filename, ok: true, rows, invalidRows: invalid }
}

/**
 * Runs `extractRowsFromImage` over every accepted file, one vision call
 * per image (never batched), sequentially so the cost + rate-limit
 * profile is predictable. Dedupes the combined row set by handle.
 */
export async function extractRowsFromImages(args: {
  files: Array<{ buffer: Buffer; filename: string }>
  platform: SocialPlatform
  metricType: SocialMetricType
  venueId: string
  correlationId?: string
  callVision?: VisionCaller
}): Promise<{ images: ImageProcessResult[]; rows: ParsedVisionRow[]; invalidRows: InvalidVisionRow[] }> {
  const images: ImageProcessResult[] = []
  for (const file of args.files) {
    const result = await extractRowsFromImage({
      buffer: file.buffer,
      filename: file.filename,
      platform: args.platform,
      metricType: args.metricType,
      venueId: args.venueId,
      correlationId: args.correlationId,
      callVision: args.callVision,
    })
    images.push(result)
  }
  const allRows = images.flatMap((i) => i.rows)
  const allInvalid = images.flatMap((i) => i.invalidRows)
  return { images, rows: dedupVisionRows(allRows), invalidRows: allInvalid }
}
