/**
 * Bar Recipe Extraction
 *
 * Ports rixey-portal's URL + upload recipe extraction. Given a recipe URL
 * (Liquor.com, Punch, NYT Cooking, etc.) or an uploaded image / PDF
 * (a screenshot of a cocktail card or a venue's printed bar manual), pulls
 * out a structured ingredients list, scaled per-serving, and persists it
 * to `bar_recipes` so the existing Bar Planner UI can scale it up to the
 * couple's actual guest count.
 *
 * Two entry points:
 *   - extractRecipeFromUrl   — fetches via Jina reader for clean markdown,
 *                              then falls back to a direct fetch + HTML strip.
 *   - extractRecipeFromBuffer — Anthropic vision (image) or document (PDF)
 *                               block, depending on the mime type.
 *
 * Both call Anthropic Sonnet through callAIJson / a direct vision-or-document
 * SDK invocation. Errors bubble up — routes translate them into 4xx / 5xx
 * at the boundary (per the project rule: error handling at boundaries only).
 */

import Anthropic from '@anthropic-ai/sdk'
import { writeOrLog } from '@/lib/db/write-or-log'
import { callAIJson, callAIVision, CLAUDE_MODEL } from '@/lib/ai/client'
import { safeFetch } from '@/lib/security/safe-fetch'
import { readCappedText, MAX_PAGE_BYTES } from '@/lib/security/fetch-limits'
import {
  recordCall,
  shouldSkip,
  isFallbackForced,
  isFallbackDisabled,
} from '@/lib/ai/circuit-breaker'
import { createServiceClient } from '@/lib/supabase/service'
import { calculateCost } from '@/lib/ai/cost-tracker'

/**
 * Prompt revision identifier. Per Playbook OPS-21.5.1 / T1-E.
 * See PROMPTS-CHANGELOG.md for version history.
 */
export const BAR_RECIPE_PROMPT_VERSION = 'bar-recipe-extract.prompt.v1.0'

// ---------------------------------------------------------------------------
// Types — match rixey-portal's shape so the existing Bar Planner UI
// (`src/app/_couple-pages/bar/page.tsx`) reads the row without changes.
// ---------------------------------------------------------------------------

export type IngredientCategory =
  | 'beer'
  | 'wine'
  | 'spirits'
  | 'mixers'
  | 'garnish'
  | 'supplies'
  | 'non-alc'
  | 'other'

export interface ExtractedIngredient {
  name: string
  quantity: number
  unit: string
  per_serving: boolean
  category: IngredientCategory
}

export interface ExtractedRecipe {
  name: string
  source_url?: string | null
  source_type: 'url' | 'upload' | 'manual'
  servings_basis: number
  ingredients: ExtractedIngredient[]
  notes?: string | null
}

export interface BarRecipeRow extends ExtractedRecipe {
  id: string
  venue_id: string
  wedding_id: string
  // What the table actually stores. the name and notes fields come from
  // ExtractedRecipe and are mapped to cocktail_name and instructions on the way
  // in and back out, so callers keep the vocabulary of a recipe rather than of
  // a column.
  servings: number | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Prompt — shared between URL and upload paths so the JSON shape is identical.
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You extract cocktail recipes from arbitrary content (web pages, recipe cards, bar manuals, photographs of menus). Return a single JSON object that matches this exact shape:

{
  "name": string,                  // cocktail name. If the content has multiple cocktails, pick the most prominent / first one.
  "servings_basis": number,        // how many servings the listed ingredient quantities make. If the page says "serves 1" use 1. If it shows a batch (e.g. "makes 12") use that number.
  "ingredients": [
    {
      "name": string,              // the ingredient itself, no quantity (e.g. "vodka", "fresh lime juice", "Aperol")
      "quantity": number,          // numeric only — convert "1 1/2" to 1.5, "a dash" to 1
      "unit": string,              // one of: oz, ml, cups, tbsp, tsp, shots, dashes, each, slices, wedges. Empty string if not applicable.
      "per_serving": true,         // always true — quantities are per single serving (we divide by servings_basis below)
      "category": "spirits" | "mixers" | "garnish" | "other"
    }
  ],
  "notes": string | null           // brief prep / build notes (1 short sentence). Null if there is nothing useful.
}

Rules:
- ALL quantities are normalised to PER ONE SERVING. If the source recipe makes a batch of 12, divide each quantity by 12 before writing.
- If a quantity is missing or ambiguous (e.g. "to taste", "a splash"), pick a reasonable default for one drink and continue. Never return a string for quantity.
- Do not invent ingredients that aren't there.
- Output JSON only. No markdown fences, no commentary.`

const VISION_TIMEOUT_MS = 45_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

// Canonical html→text. Tier-B #72: consolidated 5 local reimplementations
// to lib/utils/html-text.ts.
import { htmlToText as stripHtml } from '@/lib/utils/html-text'

/**
 * Fetch a URL through Jina's reader (`https://r.jina.ai/<url>`) which returns
 * clean markdown stripped of nav / chrome / ads. Falls back to fetching the
 * page directly + stripping HTML when Jina is unreachable or returns empty.
 */
async function fetchReadableText(url: string): Promise<string> {
  // Tier-B #88 put safeFetch on both paths here, which stopped the URL
  // being steered at an internal IP.
  //
  // S5 (2026-09-14 security audit, item 9) removes the second path
  // outright. The Jina hop is pinned to r.jina.ai — a host we chose, that
  // does the crawling on its own network — so our server never opens a
  // connection to a stranger's address at all. The direct-fetch fallback
  // did exactly that: same request, from inside our perimeter, with only
  // an IP-range check between it and whatever the DNS said. safeFetch
  // documents its own DNS-rebinding gap, and that gap is only closed by
  // not making the request. A recipe that Jina cannot read is a recipe
  // the couple types in; that is a smaller loss than the hole.
  //
  // Bodies are read with a ceiling. `res.text()` on a slow endless
  // response is a memory-exhaustion primitive, and 2 MB is several times
  // any real recipe page's text.
  let res: Response
  try {
    const jinaUrl = `https://r.jina.ai/${url}`
    res = await safeFetch(
      jinaUrl,
      {
        headers: { 'User-Agent': 'BloomHouse-Recipe-Extractor/1.0' },
        signal: AbortSignal.timeout(12_000),
      },
      { hostAllowlist: ['r.jina.ai'] },
    )
  } catch {
    throw new Error('Could not fetch recipe page (the reader did not answer).')
  }

  if (!res.ok) {
    throw new Error(`Could not fetch recipe page (HTTP ${res.status}).`)
  }

  const text = await readCappedText(res, MAX_PAGE_BYTES)
  // Jina returns markdown, but a site that served HTML through it still
  // arrives as HTML, so strip either way.
  const stripped = stripHtml(text).slice(0, 20_000)
  if (!stripped || stripped.trim().length === 0) {
    throw new Error('The recipe page returned an empty body.')
  }
  return stripped
}

/**
 * Fire-and-forget API cost log for the PDF document path, which cannot go
 * through callAIVision (image-only). Mirrors the logUsage helper in client.ts
 * so PDF calls land in the same `api_costs` table with a versioned row per
 * T1-E / OPS-21.5.1.
 */
async function logPdfUsage(
  venueId: string,
  inputTokens: number,
  outputTokens: number,
  taskType: string,
  promptVersion?: string,
) {
  try {
    const cost = calculateCost(CLAUDE_MODEL, inputTokens, outputTokens)
    const supabase = createServiceClient()
    await writeOrLog(supabase.from('api_costs').insert({
      venue_id: venueId,
      service: 'anthropic',
      model: CLAUDE_MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost,
      context: taskType,
      prompt_version: promptVersion ?? null,
    }), { op: 'api_costs.insert', venueId })
  } catch {
    // never block the caller
  }
}

// ---------------------------------------------------------------------------
// Validation — guard against the model returning the right keys with the
// wrong types. Routes turn ValidationError into a clean 422.
// ---------------------------------------------------------------------------

export class RecipeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecipeValidationError'
  }
}

function normaliseExtraction(raw: unknown, fallbackName: string): Omit<ExtractedRecipe, 'source_type' | 'source_url'> {
  if (!raw || typeof raw !== 'object') {
    throw new RecipeValidationError('AI returned a non-object response.')
  }
  const r = raw as Record<string, unknown>
  const ingredientsRaw = Array.isArray(r.ingredients) ? r.ingredients : null
  if (!ingredientsRaw || ingredientsRaw.length === 0) {
    throw new RecipeValidationError('No ingredients could be extracted.')
  }

  const ingredients: ExtractedIngredient[] = ingredientsRaw.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const obj = row as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    if (!name) return []
    const quantityNum = typeof obj.quantity === 'number'
      ? obj.quantity
      : Number.parseFloat(String(obj.quantity ?? ''))
    const quantity = Number.isFinite(quantityNum) ? quantityNum : 1
    const unit = typeof obj.unit === 'string' ? obj.unit.trim() : ''
    const categoryRaw = typeof obj.category === 'string' ? obj.category.trim().toLowerCase() : 'other'
    const validCats: IngredientCategory[] = ['beer', 'wine', 'spirits', 'mixers', 'garnish', 'supplies', 'non-alc', 'other']
    const category = (validCats as string[]).includes(categoryRaw) ? (categoryRaw as IngredientCategory) : 'other'
    return [{ name, quantity, unit, per_serving: true, category }]
  })

  if (ingredients.length === 0) {
    throw new RecipeValidationError('Extracted ingredients had no usable rows.')
  }

  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : fallbackName
  const servingsBasisNum = typeof r.servings_basis === 'number'
    ? r.servings_basis
    : Number.parseFloat(String(r.servings_basis ?? ''))
  const servings_basis = Number.isFinite(servingsBasisNum) && servingsBasisNum > 0 ? servingsBasisNum : 1
  const notes = typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null

  return { name, ingredients, servings_basis, notes }
}

// ---------------------------------------------------------------------------
// Persistence — writes to bar_recipes using the table's own column names
// (cocktail_name, ingredients, instructions, servings). Service-role client so
// this works for both demo (anon) and authenticated couples without touching
// RLS.
// ---------------------------------------------------------------------------

async function persistRecipe(
  recipe: ExtractedRecipe,
  weddingId: string,
  venueId: string
): Promise<BarRecipeRow> {
  const supabase = createServiceClient()

  // The schema's names. This wrote name / servings_per_batch / notes /
  // sort_order, on the stated grounds that the Bar Planner page read those —
  // and the page was wrong too. None of the four is a column, so every
  // extraction failed at the insert. The column list is cocktail_name,
  // ingredients, instructions, servings, scaling_factor; the print view and the
  // CSV importer have been using it all along. There is no sort_order to
  // compute, and the page orders by created_at anyway.
  const { data, error } = await supabase
    .from('bar_recipes')
    .insert({
      venue_id: venueId,
      wedding_id: weddingId,
      cocktail_name: recipe.name,
      // jsonb, so the array goes in as an array.
      ingredients: recipe.ingredients,
      servings: 1, // ingredients are per-serving; the UI scales up to guest count
      instructions: recipe.notes ?? null,
    })
    .select()
    .single()

  if (error) throw error

  const inserted = data as Record<string, unknown>
  const ingredientsBack: ExtractedIngredient[] = typeof inserted.ingredients === 'string'
    ? (JSON.parse(inserted.ingredients as string) as ExtractedIngredient[])
    : (inserted.ingredients as ExtractedIngredient[])

  return {
    id: inserted.id as string,
    venue_id: inserted.venue_id as string,
    wedding_id: inserted.wedding_id as string,
    name: inserted.cocktail_name as string,
    source_type: recipe.source_type,
    source_url: recipe.source_url ?? null,
    servings_basis: recipe.servings_basis,
    ingredients: ingredientsBack,
    notes: (inserted.instructions as string | null) ?? null,
    servings: (inserted.servings as number | null) ?? 1,
    created_at: inserted.created_at as string,
  }
}

// ---------------------------------------------------------------------------
// Public — extract from a URL
// ---------------------------------------------------------------------------

export async function extractRecipeFromUrl(
  url: string,
  weddingId: string,
  venueId: string
): Promise<BarRecipeRow> {
  // S5 (2026-09-14 security audit, item 9): https only. The page is
  // fetched through r.jina.ai either way, so plain http bought nothing
  // except a downgrade for the hop the reader makes on our behalf. Cap
  // the length too, since the URL is interpolated into the reader's path.
  if (!/^https:\/\//i.test(url)) {
    throw new RecipeValidationError('URL must start with https://')
  }
  if (url.length > 2048) {
    throw new RecipeValidationError('That URL is too long.')
  }

  const pageText = await fetchReadableText(url)

  const extracted = await callAIJson<unknown>({
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    userPrompt: `Extract the cocktail recipe from this page. Source URL: ${url}\n\nPage content (truncated to 20k chars):\n\n${pageText}`,
    maxTokens: 1200,
    temperature: 0.1,
    venueId,
    taskType: 'bar_recipe_extract_url',
    promptVersion: BAR_RECIPE_PROMPT_VERSION,
  })

  // Derive a fallback name from the URL slug if the model omitted one.
  const fallbackName = (() => {
    try {
      const path = new URL(url).pathname.split('/').filter(Boolean).pop() || 'Imported Recipe'
      return path.replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').trim() || 'Imported Recipe'
    } catch {
      return 'Imported Recipe'
    }
  })()

  const normalised = normaliseExtraction(extracted, fallbackName)
  const recipe: ExtractedRecipe = {
    ...normalised,
    source_type: 'url',
    source_url: url,
  }

  return persistRecipe(recipe, weddingId, venueId)
}

// ---------------------------------------------------------------------------
// Public — extract from an uploaded image / PDF buffer
// ---------------------------------------------------------------------------

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number]

export async function extractRecipeFromBuffer(
  buffer: Buffer,
  mimeType: string,
  weddingId: string,
  venueId: string
): Promise<BarRecipeRow> {
  const isPdf = mimeType === 'application/pdf'
  const isImage = SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType)
  if (!isPdf && !isImage) {
    throw new RecipeValidationError(`Unsupported file type: ${mimeType}. Use a PDF or an image (jpg, png, webp, gif).`)
  }

  const base64 = buffer.toString('base64')

  let parsed: unknown

  if (isImage) {
    // Images: route through callAIVision so the circuit breaker, OpenAI
    // fallback, and cost logging all apply. promptVersion threads through
    // for audit trail (T1-E / OPS-21.5.1).
    const result = await callAIVision({
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userPrompt: 'Extract the cocktail recipe from this image. Return JSON only.',
      imageBase64: base64,
      mediaType: mimeType as SupportedImageType,
      maxTokens: 1200,
      venueId,
      taskType: 'bar_recipe_extract_upload',
      promptVersion: BAR_RECIPE_PROMPT_VERSION,
    })
    const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      throw new RecipeValidationError('AI response was not valid JSON.')
    }
  } else {
    // PDFs: Anthropic SDK `document` block — callAIVision is image-only so
    // we call the SDK directly here. We manually check the circuit breaker
    // first and log to api_costs via logPdfUsage so this path is observable
    // and protected alongside every other AI call (T1-F / T1-E).
    const skipClaude = isFallbackForced() || shouldSkip('anthropic')
    if (skipClaude) {
      if (isFallbackDisabled()) {
        throw new Error('AI config conflict: AI_FORCE_FALLBACK and AI_DISABLE_FALLBACK both set.')
      }
      throw new Error(
        'AI unavailable: Anthropic circuit breaker is open. PDF extraction requires Anthropic (no document-block fallback).'
      )
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set')
    }
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const userContent = [
      {
        type: 'document' as const,
        source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 },
      },
      { type: 'text' as const, text: 'Extract the cocktail recipe from this document. Return JSON only.' },
    ]

    let response: Awaited<ReturnType<typeof anthropic.messages.create>>
    try {
      response = await withTimeout(
        anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 1200,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
        }),
        VISION_TIMEOUT_MS,
        'Anthropic PDF document call'
      )
      recordCall('anthropic', true)
    } catch (err) {
      recordCall('anthropic', false)
      throw err
    }

    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    logPdfUsage(
      venueId,
      response.usage.input_tokens,
      response.usage.output_tokens,
      'bar_recipe_extract_upload_pdf',
      BAR_RECIPE_PROMPT_VERSION,
    )

    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      throw new RecipeValidationError('AI response was not valid JSON.')
    }
  }

  const normalised = normaliseExtraction(parsed, 'Uploaded Recipe')
  const recipe: ExtractedRecipe = {
    ...normalised,
    source_type: 'upload',
    source_url: null,
  }

  return persistRecipe(recipe, weddingId, venueId)
}
