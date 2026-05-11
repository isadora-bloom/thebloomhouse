/**
 * Bloom House — Content Suggester: fetch-page.
 *
 * Anchor docs:
 *   - memory/bloom-constitution.md (the venue's own words are the
 *     source of truth — Sage's drafts and seasonal language should
 *     reflect what the venue already publishes about itself)
 *   - memory/bloom-may9-llm-vs-template.md (LLM is the primitive for
 *     extracting truth from human signals)
 *
 * What this does
 * --------------
 * Fetches a venue's marketing website (homepage + optionally one
 * shallow hop to an about/pricing/seasons page) and returns clean
 * text suitable for the USP / seasonal-content extractors. The body
 * is sanitised through the canonical htmlToText helper so scripts,
 * styles, and tag soup never reach the LLM prompt.
 *
 * Bounds:
 *   - 10s total timeout (per-request) via AbortController
 *   - 2MB body cap streamed
 *   - max 5 redirects
 *   - text/html content-type only
 *   - https-only (assertSafeUrl enforces non-private resolution)
 *
 * Designed to mirror the brain-dump url.ts fetcher's posture (SSRF
 * defense, body caps, content-type filter) while exposing a typed
 * error shape the route handlers can map to a friendly 400 message.
 */

import { assertSafeUrl, UnsafeUrlError } from '@/lib/security/safe-fetch'
import { htmlToText } from '@/lib/utils/html-text'

const FETCH_TIMEOUT_MS = 10_000
const BODY_CAP_BYTES = 2 * 1024 * 1024 // 2MB
const MAX_REDIRECTS = 5
const MAX_SUBPAGES = 2
const USER_AGENT = 'BloomHouseBot/1.0 (+https://thebloomhouse.ai)'

export type ContentFetchErrorReason =
  | 'invalid_url'
  | 'unsafe_url'
  | 'timeout'
  | 'http_error'
  | 'unsupported_content_type'
  | 'body_too_large'
  | 'fetch_failed'

export class ContentFetchError extends Error {
  constructor(public reason: ContentFetchErrorReason, message: string) {
    super(message)
    this.name = 'ContentFetchError'
  }
}

export interface FetchedPage {
  url: string
  finalUrl: string
  html: string
  textContent: string
  title: string
}

export interface FetchVenueHomepageResult {
  homepage: FetchedPage
  /** Sub-pages that were also fetched, in load order. */
  subpages: FetchedPage[]
  /** Combined text content (homepage + subpages) ready for an LLM prompt. */
  combinedText: string
}

/**
 * Normalise the operator-provided URL. Many venues store
 * "www.rixeymanor.com" or "rixeymanor.com" rather than a full
 * scheme. We accept both and upgrade to https:// when no protocol
 * is present. http:// is left intact so assertSafeUrl can reject it.
 */
export function normaliseVenueUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Already has scheme — pass through.
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  // Bare host or host+path — upgrade to https.
  return `https://${trimmed.replace(/^\/+/, '')}`
}

interface RawFetchResult {
  body: string
  finalUrl: string
}

/**
 * One-shot fetch with caps + per-hop SSRF revalidation. Throws a
 * ContentFetchError on any failure.
 */
async function fetchOne(url: string, signal: AbortSignal): Promise<RawFetchResult> {
  let currentUrl = url
  let redirectCount = 0

  while (true) {
    try {
      await assertSafeUrl(currentUrl)
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        throw new ContentFetchError('unsafe_url', `Refused to fetch ${currentUrl}: ${err.reason}`)
      }
      throw err
    }

    let resp: Response
    try {
      resp = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
        },
      })
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new ContentFetchError('timeout', `Fetch timed out after ${FETCH_TIMEOUT_MS}ms`)
      }
      throw new ContentFetchError(
        'fetch_failed',
        (err as Error).message ?? 'fetch failed',
      )
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location) {
        throw new ContentFetchError(
          'http_error',
          `Redirect ${resp.status} with no Location header`,
        )
      }
      if (redirectCount >= MAX_REDIRECTS) {
        throw new ContentFetchError(
          'http_error',
          `Exceeded max redirects (${MAX_REDIRECTS})`,
        )
      }
      redirectCount++
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    if (!resp.ok) {
      throw new ContentFetchError('http_error', `Site returned status ${resp.status}`)
    }

    const contentType = resp.headers.get('content-type') ?? ''
    if (
      !contentType.toLowerCase().includes('text/html') &&
      !contentType.toLowerCase().includes('application/xhtml')
    ) {
      throw new ContentFetchError(
        'unsupported_content_type',
        `Unsupported content-type: ${contentType || 'unknown'}`,
      )
    }

    const reader = resp.body?.getReader()
    if (!reader) {
      throw new ContentFetchError('fetch_failed', 'Response has no body')
    }
    const chunks: Uint8Array[] = []
    let total = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > BODY_CAP_BYTES) {
          try { await reader.cancel() } catch { /* ignore */ }
          throw new ContentFetchError(
            'body_too_large',
            `Body exceeds ${BODY_CAP_BYTES} byte cap`,
          )
        }
        chunks.push(value)
      }
    }
    const buf = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      buf.set(c, offset)
      offset += c.byteLength
    }
    const body = new TextDecoder('utf-8', { fatal: false }).decode(buf)
    return { body, finalUrl: currentUrl }
  }
}

/** Extract the <title> element value from raw HTML. */
function readTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  return htmlToText(m[1]).slice(0, 200).trim()
}

/**
 * Find candidate sub-page URLs (about, pricing, seasons, weddings)
 * linked from the homepage. Returns absolute URLs scoped to the same
 * host as the homepage. Conservative — at most MAX_SUBPAGES.
 */
function findSubpageCandidates(homepageHtml: string, homepageUrl: string): string[] {
  let baseHost: string
  let base: URL
  try {
    base = new URL(homepageUrl)
    baseHost = base.hostname.toLowerCase()
  } catch {
    return []
  }

  const candidates = new Set<string>()
  // Keywords that suggest a page useful for USPs / seasonal content.
  const interestingKeywords = [
    'about',
    'story',
    'venue',
    'pricing',
    'rates',
    'experience',
    'season',
    'weddings',
    'gallery',
  ]

  // Match every href on the page.
  const hrefRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = hrefRegex.exec(homepageHtml)) !== null) {
    const rawHref = match[1]
    const linkTextRaw = match[2]
    if (!rawHref) continue
    // Skip anchors, mailto, tel, javascript.
    if (rawHref.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(rawHref)) continue
    let abs: URL
    try {
      abs = new URL(rawHref, homepageUrl)
    } catch {
      continue
    }
    if (abs.hostname.toLowerCase() !== baseHost) continue
    if (!/^https?:$/i.test(abs.protocol)) continue
    // Skip the homepage itself.
    if (abs.pathname === '/' || abs.pathname === '' || abs.pathname === base.pathname) continue

    const haystack = `${abs.pathname.toLowerCase()} ${htmlToText(linkTextRaw).toLowerCase()}`
    if (interestingKeywords.some((kw) => haystack.includes(kw))) {
      // Drop the fragment + querystring for dedupe stability.
      abs.hash = ''
      abs.search = ''
      candidates.add(abs.toString())
    }
    if (candidates.size >= MAX_SUBPAGES * 4) break // early stop after a sensible scan
  }

  return Array.from(candidates).slice(0, MAX_SUBPAGES)
}

/**
 * Public entry point — fetch a venue homepage plus up to MAX_SUBPAGES
 * topically relevant subpages. Returns a structured result the
 * extractors can pass straight to the LLM prompt builder.
 *
 * Throws ContentFetchError on the homepage fetch. Subpage failures
 * are swallowed (best-effort enrichment, never fatal).
 */
export async function fetchVenueHomepage(
  rawUrl: string,
): Promise<FetchVenueHomepageResult> {
  const url = normaliseVenueUrl(rawUrl)
  if (!url) {
    throw new ContentFetchError('invalid_url', 'Website URL is empty.')
  }
  try {
    // Validates the URL parses before we open the controller.
    new URL(url)
  } catch {
    throw new ContentFetchError('invalid_url', `Not a valid URL: ${rawUrl}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const homepageRaw = await fetchOne(url, controller.signal)
    const homepageText = htmlToText(homepageRaw.body)
    const homepageTitle = readTitle(homepageRaw.body)
    const homepage: FetchedPage = {
      url,
      finalUrl: homepageRaw.finalUrl,
      html: homepageRaw.body,
      textContent: homepageText,
      title: homepageTitle,
    }

    const subpageUrls = findSubpageCandidates(homepageRaw.body, homepageRaw.finalUrl)
    const subpages: FetchedPage[] = []
    for (const subUrl of subpageUrls) {
      try {
        const sub = await fetchOne(subUrl, controller.signal)
        subpages.push({
          url: subUrl,
          finalUrl: sub.finalUrl,
          html: sub.body,
          textContent: htmlToText(sub.body),
          title: readTitle(sub.body),
        })
      } catch {
        // Subpage failures are non-fatal — homepage alone is enough.
      }
    }

    const combinedParts: string[] = []
    combinedParts.push(`# HOMEPAGE: ${homepage.finalUrl}`)
    if (homepage.title) combinedParts.push(`Title: ${homepage.title}`)
    combinedParts.push('')
    combinedParts.push(homepage.textContent)
    for (const s of subpages) {
      combinedParts.push('')
      combinedParts.push(`# SUBPAGE: ${s.finalUrl}`)
      if (s.title) combinedParts.push(`Title: ${s.title}`)
      combinedParts.push('')
      combinedParts.push(s.textContent)
    }
    const combinedText = combinedParts.join('\n')

    return { homepage, subpages, combinedText }
  } finally {
    clearTimeout(timer)
  }
}
