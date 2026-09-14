/**
 * Screenshot capture -- image handling with a stubbed vision client.
 *
 * NOVEMBER-PLAN.md wave 6, W41. These tests guard three things: a file
 * that fails the size/type gate never reaches Sharp or the model; a
 * resized image actually shrinks and re-encodes to WebP (never sends a
 * raw screenshot to the model); and the model's JSON reply is validated
 * row by row, so a malformed row is reported rather than silently
 * dropped or silently accepted.
 */

import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  validateUploadedFile,
  validateVisionRow,
  validateVisionRows,
  dedupVisionRows,
  resizeImageForVision,
  extractRowsFromImage,
  extractRowsFromImages,
  isSocialPlatform,
  isSocialMetricType,
  MAX_IMAGE_BYTES,
  RESIZE_MAX_WIDTH,
  type VisionCaller,
} from '../screenshot'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real (tiny) PNG buffer -- Sharp needs actual image bytes, not a
 *  fake string, to prove the resize step really runs. */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 120 } },
  })
    .png()
    .toBuffer()
}

// ---------------------------------------------------------------------------
// Upload gate
// ---------------------------------------------------------------------------

describe('validateUploadedFile', () => {
  it('accepts a normal jpeg within the size cap', () => {
    expect(validateUploadedFile({ name: 'a.jpg', size: 1_000_000, type: 'image/jpeg' })).toEqual({ ok: true })
  })

  it('rejects a file over 10 MB', () => {
    const out = validateUploadedFile({ name: 'big.png', size: MAX_IMAGE_BYTES + 1, type: 'image/png' })
    expect(out).toEqual({ ok: false, reason: 'file_too_large' })
  })

  it('rejects an unsupported mime type', () => {
    const out = validateUploadedFile({ name: 'doc.pdf', size: 1000, type: 'application/pdf' })
    expect(out).toEqual({ ok: false, reason: 'unsupported_type' })
  })

  it('rejects an empty file', () => {
    const out = validateUploadedFile({ name: 'empty.png', size: 0, type: 'image/png' })
    expect(out).toEqual({ ok: false, reason: 'empty_file' })
  })

  it('accepts exactly the 10 MB boundary', () => {
    expect(validateUploadedFile({ name: 'edge.png', size: MAX_IMAGE_BYTES, type: 'image/png' })).toEqual({ ok: true })
  })

  it('is case-insensitive on mime type', () => {
    expect(validateUploadedFile({ name: 'a.jpg', size: 1000, type: 'IMAGE/JPEG' })).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Platform / metric validation
// ---------------------------------------------------------------------------

describe('isSocialPlatform / isSocialMetricType', () => {
  it('accepts the four capture platforms', () => {
    for (const p of ['instagram', 'tiktok', 'facebook', 'pinterest']) expect(isSocialPlatform(p)).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isSocialPlatform('myspace')).toBe(false)
  })
  it('accepts every metric the vision prompt defines, including story views and DMs', () => {
    for (const m of ['new_followers', 'story_views', 'dms', 'profile_visits', 'post_engagement']) {
      expect(isSocialMetricType(m)).toBe(true)
    }
  })
  it('rejects an unknown metric', () => {
    expect(isSocialMetricType('made_up_metric')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Row validation -- the parser's row shape
// ---------------------------------------------------------------------------

describe('validateVisionRow', () => {
  it('accepts a well-formed row', () => {
    const out = validateVisionRow(
      { handle: '@Rosie.Hoyle', display_name: 'Rosie Hoyle', action: 'started_following', relative_age: '2d', status: null },
      0,
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.row).toEqual({
        handle: 'rosie.hoyle',
        display_name: 'Rosie Hoyle',
        relative_age: '2d',
        vision_action: 'started_following',
      })
    }
  })

  it('rejects a row with no handle', () => {
    const out = validateVisionRow({ action: 'started_following' }, 1)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.reason).toBe('missing or empty handle')
  })

  it('rejects a row whose handle contains a space (a UI label, not a handle)', () => {
    const out = validateVisionRow({ handle: 'all people', action: 'started_following' }, 2)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.reason).toBe('handle contains whitespace')
  })

  it('rejects a row missing the required action field', () => {
    const out = validateVisionRow({ handle: 'jen_bee' }, 3)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.reason).toBe('missing action')
  })

  it('rejects a row that is not an object (the model emitted a bare string)', () => {
    const out = validateVisionRow('rosie.hoyle', 4)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.reason).toBe('row is not an object')
  })

  it('rejects an implausible status value', () => {
    const out = validateVisionRow({ handle: 'a', action: 'started_following', status: 'best_friends' }, 5)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.reason).toBe('status not one of the allowed values')
  })

  it('carries a handle hint on a rejected row so the operator sees which one', () => {
    const out = validateVisionRow({ handle: 'way.too.long.a.handle.for.instagram.by.a.wide.margin.of.characters', action: 'started_following' }, 6)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.handle_hint).toBeTruthy()
  })
})

describe('validateVisionRows', () => {
  it('separates valid rows from a malformed one in the same array, never throws', () => {
    const raw = [
      { handle: 'rosie.hoyle', display_name: 'Rosie Hoyle', action: 'started_following', relative_age: '2d' },
      { handle: '', action: 'started_following' }, // malformed: empty handle
      { handle: 'jen_bee', action: 'started_following', relative_age: '1w' },
    ]
    const { rows, invalid } = validateVisionRows(raw)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.handle)).toEqual(['rosie.hoyle', 'jen_bee'])
    expect(invalid).toHaveLength(1)
    expect(invalid[0].reason).toBe('missing or empty handle')
  })

  it('reports the whole reply as invalid when the model did not return an array', () => {
    const { rows, invalid } = validateVisionRows({ not: 'an array' })
    expect(rows).toEqual([])
    expect(invalid).toHaveLength(1)
    expect(invalid[0].reason).toBe('model did not return a JSON array')
  })

  it('handles an empty array cleanly', () => {
    expect(validateVisionRows([])).toEqual({ rows: [], invalid: [] })
  })
})

describe('dedupVisionRows', () => {
  it('keeps the first occurrence of a repeated handle', () => {
    const rows = dedupVisionRows([
      { handle: 'a', display_name: 'First', relative_age: null, vision_action: 'started_following' },
      { handle: 'a', display_name: 'Second', relative_age: null, vision_action: 'started_following' },
      { handle: 'b', display_name: null, relative_age: null, vision_action: 'started_following' },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].display_name).toBe('First')
  })
})

// ---------------------------------------------------------------------------
// Resize -- proves Sharp actually runs and bounds the output.
// ---------------------------------------------------------------------------

describe('resizeImageForVision', () => {
  it('shrinks an oversized image to the max width and re-encodes as webp', async () => {
    const original = await makePng(3000, 1500)
    const resized = await resizeImageForVision(original)
    const meta = await sharp(resized).metadata()
    expect(meta.width).toBeLessThanOrEqual(RESIZE_MAX_WIDTH)
    expect(meta.format).toBe('webp')
    expect(resized.length).toBeLessThan(original.length)
  })

  it('does not upscale a small image past its own size', async () => {
    const original = await makePng(200, 100)
    const resized = await resizeImageForVision(original)
    const meta = await sharp(resized).metadata()
    expect(meta.width).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// extractRowsFromImage -- stubbed vision client
// ---------------------------------------------------------------------------

function stubVision(text: string): VisionCaller {
  return async () => ({ text })
}

describe('extractRowsFromImage', () => {
  it('returns valid rows from a clean model reply', async () => {
    const buffer = await makePng(100, 100)
    const callVision = stubVision(
      JSON.stringify([
        { handle: 'rosie.hoyle', display_name: 'Rosie Hoyle', action: 'started_following', relative_age: '2d', status: null },
        { handle: 'jen_bee', display_name: null, action: 'started_following', relative_age: '1w', status: 'not_following_back' },
      ]),
    )
    const result = await extractRowsFromImage({
      buffer,
      filename: 'followers.png',
      platform: 'instagram',
      metricType: 'new_followers',
      venueId: 'venue-1',
      callVision,
    })
    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(2)
    expect(result.invalidRows).toHaveLength(0)
  })

  it('reports a malformed row without dropping the valid ones alongside it', async () => {
    const buffer = await makePng(100, 100)
    const callVision = stubVision(
      JSON.stringify([
        { handle: 'rosie.hoyle', action: 'started_following' },
        { handle: '', action: 'started_following' }, // malformed
        { handle: 'jen_bee', action: 'started_following' },
      ]),
    )
    const result = await extractRowsFromImage({
      buffer,
      filename: 'mixed.png',
      platform: 'instagram',
      metricType: 'new_followers',
      venueId: 'venue-1',
      callVision,
    })
    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(2)
    expect(result.invalidRows).toHaveLength(1)
  })

  it('handles the model wrapping JSON in a markdown fence', async () => {
    const buffer = await makePng(100, 100)
    const callVision = stubVision('```json\n[{"handle":"a","action":"started_following"}]\n```')
    const result = await extractRowsFromImage({
      buffer,
      filename: 'fenced.png',
      platform: 'instagram',
      metricType: 'new_followers',
      venueId: 'venue-1',
      callVision,
    })
    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(1)
  })

  it('fails cleanly when the model reply is not valid JSON', async () => {
    const buffer = await makePng(100, 100)
    const callVision = stubVision('sorry, I cannot read this image')
    const result = await extractRowsFromImage({
      buffer,
      filename: 'garbage.png',
      platform: 'instagram',
      metricType: 'new_followers',
      venueId: 'venue-1',
      callVision,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('model did not return valid JSON')
    expect(result.rows).toEqual([])
  })

  it('fails cleanly when the vision call itself throws (provider outage)', async () => {
    const buffer = await makePng(100, 100)
    const callVision: VisionCaller = async () => {
      throw new Error('AI unavailable: both Claude and OpenAI vision fallback failed.')
    }
    const result = await extractRowsFromImage({
      buffer,
      filename: 'outage.png',
      platform: 'instagram',
      metricType: 'new_followers',
      venueId: 'venue-1',
      callVision,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('vision call failed')
  })

  it('sends a resized (small) webp payload to the vision client, never the raw upload', async () => {
    const original = await makePng(3000, 2000)
    let seenBase64 = ''
    let seenMediaType = ''
    const callVision: VisionCaller = async (args) => {
      seenBase64 = args.imageBase64
      seenMediaType = args.mediaType
      return { text: '[]' }
    }
    await extractRowsFromImage({
      buffer: original,
      filename: 'huge.png',
      platform: 'instagram',
      metricType: 'new_followers',
      venueId: 'venue-1',
      callVision,
    })
    expect(seenMediaType).toBe('image/webp')
    const sentBytes = Buffer.from(seenBase64, 'base64').length
    expect(sentBytes).toBeLessThan(original.length)
    const meta = await sharp(Buffer.from(seenBase64, 'base64')).metadata()
    expect(meta.width).toBeLessThanOrEqual(RESIZE_MAX_WIDTH)
  })
})

// ---------------------------------------------------------------------------
// extractRowsFromImages -- one call per image, deduped across images
// ---------------------------------------------------------------------------

describe('extractRowsFromImages', () => {
  it('calls vision exactly once per image', async () => {
    const buffer = await makePng(50, 50)
    let calls = 0
    const callVision: VisionCaller = async () => {
      calls += 1
      return { text: JSON.stringify([{ handle: `h${calls}`, action: 'started_following' }]) }
    }
    const result = await extractRowsFromImages({
      files: [
        { buffer, filename: 'a.png' },
        { buffer, filename: 'b.png' },
        { buffer, filename: 'c.png' },
      ],
      platform: 'instagram',
      metricType: 'new_followers',
      venueId: 'venue-1',
      callVision,
    })
    expect(calls).toBe(3)
    expect(result.images).toHaveLength(3)
    expect(result.rows).toHaveLength(3)
  })

  it('dedups a handle that appears in two overlapping screenshots', async () => {
    const buffer = await makePng(50, 50)
    let call = 0
    const callVision: VisionCaller = async () => {
      call += 1
      // Both screenshots see 'rosie.hoyle'; the second scroll also picks up 'jen_bee'.
      const rows = call === 1
        ? [{ handle: 'rosie.hoyle', action: 'started_following' }]
        : [{ handle: 'rosie.hoyle', action: 'started_following' }, { handle: 'jen_bee', action: 'started_following' }]
      return { text: JSON.stringify(rows) }
    }
    const result = await extractRowsFromImages({
      files: [
        { buffer, filename: 'scroll-1.png' },
        { buffer, filename: 'scroll-2.png' },
      ],
      platform: 'instagram',
      metricType: 'new_followers',
      venueId: 'venue-1',
      callVision,
    })
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map((r) => r.handle).sort()).toEqual(['jen_bee', 'rosie.hoyle'])
  })
})
