/**
 * Bloom House: Sage email auto-attach matcher
 *
 * Given an outbound email reply (subject + inbound body + reply draft),
 * picks 0-3 brand_assets photos that would feel relevant attached. Used
 * by the email-send path (autonomous + coordinator-approved) when the
 * venue has opted in via venue_config.auto_attach_photos.
 *
 * Hard rules:
 *   - Returns [] on any failure. Never throws — must not block email.
 *   - Returns [] when the venue has not opted in (matcher short-circuits
 *     before touching the LLM).
 *   - Caps eligible-asset corpus at 30 rows to bound prompt size — runaway
 *     libraries don't get prompted in full.
 *   - Caps return count at maxAttachments (default 2) regardless of what
 *     the model returns.
 *   - Drops any model-returned id that wasn't in the input list.
 *
 * Pairs with:
 *   - migration 243 (brand_assets.sage_eligible / category / caption /
 *     mime_type / file_size_bytes) — owned by the parallel agent.
 *   - migration 244 (venue_config.auto_attach_photos toggle).
 *   - src/lib/services/email/pipeline.ts (autonomous send + flush)
 *     and sendApprovedDraft, which call this at the send boundary.
 */

import { callAIJson } from '@/lib/ai/client'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Prompt versioning
// ---------------------------------------------------------------------------

/**
 * Logged to api_costs.prompt_version on every matcher call so cost +
 * accuracy regressions can be tracked per revision. Bump + add a row in
 * PROMPTS-CHANGELOG.md when the system prompt or response contract
 * changes meaningfully.
 */
export const BRAIN_ASSET_MATCHER_PROMPT_VERSION = 'asset-matcher.prompt.v1.0'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatchedAsset {
  id: string
  url: string
  caption: string | null
  category: string | null
  /** Storage path inside the `venue-assets` bucket, when the asset was
   *  uploaded via the migration-243 flow. Null for legacy URL-paste rows
   *  whose `url` points outside Supabase Storage. */
  storagePath: string | null
  mimeType: string | null
}

export interface MatchAssetsOptions {
  maxAttachments?: number
}

interface BrandAssetRow {
  id: string
  url: string
  caption: string | null
  category: string | null
  mime_type: string | null
  asset_type: string | null
  sage_eligible: boolean | null
  label: string | null
}

interface MatcherResponse {
  matches?: Array<{ id?: unknown; reason?: unknown }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_ELIGIBLE_ASSETS = 30
const DEFAULT_MAX_ATTACHMENTS = 2
const MAX_RETURN = 3

const SYSTEM_PROMPT = [
  'You decide whether to attach venue photos to a wedding-venue email reply.',
  '',
  'Rules:',
  '  - You pick 0 to 3 photos from a numbered list. Empty is the right answer most of the time.',
  '  - Attach a photo only if it would clearly add value to this specific email.',
  '  - "Add value" means the photo answers a question the couple is asking, ',
  '    illustrates a space the email mentions, or reinforces something the reply',
  '    promises. Generic "this looks nice" is not a reason.',
  '  - Skip if you are not sure. Coordinators trust silence more than noise.',
  '  - Match the photo category to what is being discussed: ceremony space for ',
  '    ceremony questions, tent for rain plan or cocktail tent, reception for ',
  '    dinner / dance-floor questions, exterior for arrival or curb-appeal, ',
  '    detail for closeups (florals, place settings).',
  '',
  'Output a single JSON object: { "matches": [{ "id": "<uuid>", "reason": "<short>" }] }',
  'Only include ids from the provided list. Do not invent ids. Maximum 3.',
].join('\n')

/**
 * Pull the bucket-relative path out of a Supabase Storage public URL.
 * Returns null when the URL doesn't look like a Storage URL — caller
 * falls back to a plain HTTP fetch.
 *
 * Public URL shape:
 *   https://<proj>.supabase.co/storage/v1/object/public/venue-assets/<path>
 *
 * The matcher uses the path segment after `/venue-assets/` so the
 * service-role client can pull bytes via .storage.download() without
 * round-tripping the public CDN.
 */
function extractStoragePath(url: string | null | undefined): string | null {
  if (!url) return null
  const match = url.match(/\/storage\/v1\/object\/(?:public|sign)\/venue-assets\/(.+?)(?:\?|$)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? trimmed.slice(0, max) + '...' : trimmed
}

function buildUserPrompt(
  emailContext: { subject?: string; body: string; replyDraft: string },
  assets: BrandAssetRow[],
): string {
  const parts: string[] = []
  parts.push('EMAIL CONTEXT')
  parts.push('Subject: ' + truncate(emailContext.subject, 160))
  parts.push('')
  parts.push('Inbound body (what the couple wrote):')
  parts.push(truncate(emailContext.body, 1200))
  parts.push('')
  parts.push('Outbound reply draft (what we are about to send):')
  parts.push(truncate(emailContext.replyDraft, 1200))
  parts.push('')
  parts.push('AVAILABLE PHOTOS (only choose from these ids):')
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i]
    const cat = (a.category ?? 'uncategorised').toString()
    const cap = truncate(a.caption ?? a.label ?? '', 140)
    parts.push(
      `  ${i + 1}. id=${a.id}  category=${cat}  caption="${cap}"`,
    )
  }
  parts.push('')
  parts.push('Return JSON only.')
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Pick 0-N relevant photos for an outbound email reply. Returns [] for
 * any failure path, including:
 *   - venue not opted in (auto_attach_photos = false)
 *   - no eligible brand_assets rows
 *   - LLM call throws / times out / returns malformed JSON
 *   - LLM returns ids not in the provided list (after filtering)
 *
 * The caller is expected to forward correlationId for cost-row threading.
 */
export async function matchAssetsForEmail(
  venueId: string,
  emailContext: { subject?: string; body: string; replyDraft: string },
  options: MatchAssetsOptions & { correlationId?: string } = {},
): Promise<MatchedAsset[]> {
  if (!venueId) return []

  const maxAttachments = Math.min(
    MAX_RETURN,
    Math.max(0, options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS),
  )
  if (maxAttachments === 0) return []

  try {
    const supabase = createServiceClient()

    // Opt-in gate. Default OFF — coordinators must flip the toggle in
    // Settings before any LLM call happens.
    const { data: cfg } = await supabase
      .from('venue_config')
      .select('auto_attach_photos')
      .eq('venue_id', venueId)
      .maybeSingle()

    if (!cfg || cfg.auto_attach_photos !== true) return []

    // Pull eligible assets. Restrict to photo-class rows so we don't
    // accidentally attach a logo or a watercolor texture as a "ceremony
    // photo". Ordered by created_at so the corpus is stable run-to-run.
    const { data: assetRows } = await supabase
      .from('brand_assets')
      .select('id, url, caption, category, mime_type, asset_type, sage_eligible, label')
      .eq('venue_id', venueId)
      .eq('sage_eligible', true)
      .in('asset_type', ['hero_image', 'photography'])
      .order('created_at', { ascending: true })
      .limit(MAX_ELIGIBLE_ASSETS)

    const assets = (assetRows ?? []) as BrandAssetRow[]
    if (assets.length === 0) return []

    // Build the prompt and call Haiku. callAIJson handles retries +
    // OpenAI fallback transparently.
    const userPrompt = buildUserPrompt(emailContext, assets)

    const response = await callAIJson<MatcherResponse>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 400,
      temperature: 0.2,
      tier: 'haiku',
      taskType: 'email_asset_match',
      contentTier: 2,
      promptVersion: BRAIN_ASSET_MATCHER_PROMPT_VERSION,
      venueId,
      correlationId: options.correlationId,
    })

    const rawMatches = Array.isArray(response?.matches) ? response.matches : []
    if (rawMatches.length === 0) return []

    // Filter to ids that exist in the input list. Defends against the
    // model hallucinating uuids or returning ids from a previous prompt
    // in the same conversation buffer.
    const eligibleById = new Map<string, BrandAssetRow>()
    for (const a of assets) eligibleById.set(a.id, a)

    const out: MatchedAsset[] = []
    const seen = new Set<string>()
    for (const m of rawMatches) {
      if (out.length >= maxAttachments) break
      const id = typeof m?.id === 'string' ? m.id : null
      if (!id) continue
      if (seen.has(id)) continue
      const row = eligibleById.get(id)
      if (!row) continue
      seen.add(id)
      out.push({
        id: row.id,
        url: row.url,
        caption: row.caption ?? row.label ?? null,
        category: row.category ?? null,
        storagePath: extractStoragePath(row.url),
        mimeType: row.mime_type ?? null,
      })
    }

    return out
  } catch (err) {
    // Never block email send. Log and bail.
    console.warn(
      '[asset-matcher] match failed (returning empty):',
      err instanceof Error ? err.message : err,
    )
    return []
  }
}

// ---------------------------------------------------------------------------
// Bytes loader for the email-send path
// ---------------------------------------------------------------------------

/**
 * Load an asset's bytes. For Storage-backed rows (storagePath set), pulls
 * via supabase.storage.download(). For URL-paste legacy rows, fetches the
 * URL with a 10s timeout and reads the body as bytes.
 *
 * Returns null on any failure — caller should drop the attachment.
 */
export async function loadAssetBytes(asset: MatchedAsset): Promise<Buffer | null> {
  try {
    if (asset.storagePath) {
      const supabase = createServiceClient()
      const { data, error } = await supabase.storage
        .from('venue-assets')
        .download(asset.storagePath)
      if (error || !data) return null
      const arrayBuf = await data.arrayBuffer()
      return Buffer.from(arrayBuf)
    }

    // Fallback: external URL fetch.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(asset.url, { signal: controller.signal })
      if (!res.ok) return null
      const arrayBuf = await res.arrayBuffer()
      return Buffer.from(arrayBuf)
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    console.warn(
      '[asset-matcher] loadAssetBytes failed:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Build a sensible filename for an attachment. Coordinator-friendly so
 * the couple sees "ceremony.jpg" not "8f4d-...-uuid.bin".
 */
export function filenameForAsset(asset: MatchedAsset): string {
  const cat = (asset.category ?? 'photo').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  const ext = mimeToExt(asset.mimeType)
  return `${cat || 'photo'}.${ext}`
}

function mimeToExt(mime: string | null): string {
  if (!mime) return 'jpg'
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  return 'jpg'
}
