/**
 * Brain-dump URL fast path (T5-ι.3).
 *
 * Detects when a brain-dump entry's raw text is just a URL (or a URL
 * with negligible surrounding context — e.g. "saved this", "look at
 * this") and fetches enough of the page to feed the classifier with
 * something useful instead of routing the bare URL string into Sage's
 * memory as opaque text.
 *
 * Targeted shapes:
 *   - Pinterest URL → og:image + caption (inspiration / aesthetic)
 *   - Google Doc URL → propose-and-confirm asking for paste OR drive
 *     auth (no OAuth flow yet — defer)
 *   - Generic URL → og:title + og:description (or <title> + first <p>)
 *
 * Bound by:
 *   - 5s fetch timeout
 *   - 2MB body cap
 *   - max 2 redirects
 *   - HTML body sanitization (script/style stripped before classifier)
 *
 * Per Playbook INV-20.5.4-A every URL fetch surfaces a propose-and-
 * confirm — never a silent file. The route handler creates the
 * notification + parks the brain_dump_entries row in
 * needs_clarification; the coordinator confirms via the standard
 * Notifications resolve flow.
 */

const URL_TIMEOUT_MS = 5_000
const BODY_CAP_BYTES = 2 * 1024 * 1024 // 2MB
const MAX_REDIRECTS = 2

export type UrlShape = 'pinterest' | 'google_doc' | 'generic'

export interface UrlFetchResult {
  ok: boolean
  shape: UrlShape
  /** Cleaned title / og:title. */
  title: string | null
  /** Cleaned description / og:description / first paragraph. */
  description: string | null
  /** Pinterest pin image URL when applicable. */
  imageUrl: string | null
  /** Concatenated title + description, suitable as classifier rawText. */
  extractedText: string
  /** Why this URL handler is in propose-only mode (Google Doc deferred OAuth). */
  proposeOnlyReason?: 'google_doc_oauth_unavailable'
  /** Surfaced to the coordinator in the confirm prompt. */
  summaryForCoordinator: string
  reason?: string
  /** Original URL after parsing — useful for the confirm message. */
  url: string
}

/**
 * Detect whether the brain-dump rawText is URL-only (the coordinator
 * pasted nothing but a link, possibly with whitespace and trivial
 * preamble like "this:" or "fyi"). We're conservative — if the text
 * has more than a tiny bit of free-form prose, route through the
 * normal classifier so the prose context is preserved.
 *
 * Returns the URL string if URL-only, else null.
 */
export function detectUrlOnlyInput(rawText: string): string | null {
  const trimmed = rawText.trim()
  if (!trimmed) return null

  // Quick reject: if the text is much longer than any reasonable URL,
  // it is not URL-only.
  if (trimmed.length > 2_000) return null

  // Find the first http(s) URL in the text.
  const match = trimmed.match(/https?:\/\/[^\s<>"'()]+/i)
  if (!match) return null
  const url = match[0]

  // Strip the URL out and see what's left.
  const remainder = trimmed.replace(url, '').trim()
  // Allow up to 40 chars of trivial prose around the URL ("look at this",
  // "saved this", "fyi —").
  if (remainder.length > 40) return null

  // Validate it parses as a URL.
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

/** Determine which extraction shape applies to a URL. */
export function classifyUrlShape(url: string): UrlShape {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'pinterest.com' || host.endsWith('.pinterest.com')) return 'pinterest'
    if (host === 'docs.google.com' && parsed.pathname.startsWith('/document/')) return 'google_doc'
  } catch {
    // fall through
  }
  return 'generic'
}

/**
 * Fetch a URL with timeout / size / redirect caps. Returns ok=false on
 * any failure mode (timeout, oversized body, non-2xx, non-HTML
 * content-type). Never throws.
 */
async function fetchWithCaps(url: string): Promise<{
  ok: true
  body: string
  finalUrl: string
  contentType: string
} | { ok: false; reason: string }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), URL_TIMEOUT_MS)

  let redirectCount = 0
  let currentUrl = url

  try {
    // SSRF defense: validate the initial URL AND each redirect hop. Per
    // 2026-05-06 audit Lens 8 — the redirect loop was the TOCTOU vector.
    // assertSafeUrl throws UnsafeUrlError for private/link-local/loopback
    // IPs and non-https protocols.
    const { assertSafeUrl, UnsafeUrlError } = await import('@/lib/security/safe-fetch')
    while (true) {
      try {
        await assertSafeUrl(currentUrl)
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          return { ok: false, reason: err.reason }
        }
        throw err
      }

      const resp = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Avoid 403 from some CDNs; identify ourselves as a bot
          // honestly so site owners can block if they wish.
          'User-Agent': 'BloomHouseBot/1.0 (+https://thebloomhouse.ai)',
          Accept: 'text/html,application/xhtml+xml',
        },
      })

      // Handle manual redirects.
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location')
        if (!loc) return { ok: false, reason: `redirect with no Location header (status ${resp.status})` }
        if (redirectCount >= MAX_REDIRECTS) {
          return { ok: false, reason: `exceeded max redirects (${MAX_REDIRECTS})` }
        }
        redirectCount++
        currentUrl = new URL(loc, currentUrl).toString()
        continue
      }

      if (!resp.ok) {
        return { ok: false, reason: `non-2xx status ${resp.status}` }
      }

      const contentType = resp.headers.get('content-type') ?? ''
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return { ok: false, reason: `unsupported content-type: ${contentType || 'unknown'}` }
      }

      // Stream-read with size cap. Avoid resp.text() on a huge body.
      const reader = resp.body?.getReader()
      if (!reader) return { ok: false, reason: 'response has no body' }
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
            return { ok: false, reason: `body exceeds ${BODY_CAP_BYTES} byte cap` }
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
      return { ok: true, body, finalUrl: currentUrl, contentType }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      return { ok: false, reason: `fetch timed out after ${URL_TIMEOUT_MS}ms` }
    }
    return { ok: false, reason: (err as Error).message ?? 'fetch failed' }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Strip script, style, and other markup from raw HTML. Returns the
 * cleaned body. Not a full HTML parser — meta-tag extraction is done
 * separately and treated as authoritative when present.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Read a meta-tag value from a raw HTML blob. */
function readMeta(html: string, propertyOrName: string): string | null {
  // og:* uses property=, twitter:* uses name=, classic <meta name="...">
  // also exists. Try both.
  const escapedKey = propertyOrName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const re1 = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${escapedKey}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i',
  )
  const re2 = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${escapedKey}["']`,
    'i',
  )
  return html.match(re1)?.[1] ?? html.match(re2)?.[1] ?? null
}

/** Read the <title> tag value. */
function readTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? stripHtml(m[1]) : null
}

/** Read the first <p> tag value. */
function readFirstParagraph(html: string): string | null {
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
  return m ? stripHtml(m[1]) : null
}

function buildSummary(args: {
  shape: UrlShape
  url: string
  title: string | null
  description: string | null
  imageUrl: string | null
}): string {
  const { shape, url, title, description, imageUrl } = args
  const parts: string[] = []
  if (shape === 'pinterest') {
    parts.push('Pinterest pin')
    if (title) parts.push(`— ${title}`)
    if (description) parts.push(`(${description.slice(0, 200)}${description.length > 200 ? '…' : ''})`)
    if (imageUrl) parts.push(`[image: ${imageUrl}]`)
  } else {
    if (title) parts.push(title)
    if (description) parts.push(description.slice(0, 240) + (description.length > 240 ? '…' : ''))
    if (parts.length === 0) parts.push(url)
  }
  return parts.join(' ').slice(0, 800)
}

/**
 * Fetch + extract for a Pinterest pin URL. Pinterest serves enough
 * og:* metadata that we don't need the API.
 */
async function handlePinterest(url: string): Promise<UrlFetchResult> {
  const fetched = await fetchWithCaps(url)
  if (!fetched.ok) {
    return {
      ok: false,
      shape: 'pinterest',
      title: null,
      description: null,
      imageUrl: null,
      extractedText: '',
      summaryForCoordinator: `Couldn't fetch Pinterest URL: ${fetched.reason}`,
      reason: fetched.reason,
      url,
    }
  }
  const { body } = fetched
  const ogTitle = readMeta(body, 'og:title')
  const ogDescription = readMeta(body, 'og:description')
  const ogImage = readMeta(body, 'og:image')
  const twDescription = readMeta(body, 'twitter:description')
  const description = ogDescription ?? twDescription ?? readFirstParagraph(body)
  const title = ogTitle ?? readTitle(body)
  const summary = buildSummary({
    shape: 'pinterest',
    url,
    title,
    description,
    imageUrl: ogImage,
  })
  const extractedText = [
    title ? `Pinterest pin: ${title}` : 'Pinterest pin',
    description ?? '',
    ogImage ? `[pin image: ${ogImage}]` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    ok: true,
    shape: 'pinterest',
    title,
    description,
    imageUrl: ogImage,
    extractedText,
    summaryForCoordinator: summary,
    url,
  }
}

/** Google Doc URL: defer to coordinator (no OAuth flow yet). */
function handleGoogleDoc(url: string): UrlFetchResult {
  return {
    ok: true,
    shape: 'google_doc',
    title: null,
    description: null,
    imageUrl: null,
    extractedText: '',
    proposeOnlyReason: 'google_doc_oauth_unavailable',
    summaryForCoordinator:
      'Google Doc detected — Drive integration is not connected yet. ' +
      'Either paste the doc text into the brain-dump, or grant Drive access (coming soon) so I can read it directly.',
    url,
  }
}

/** Generic URL fetch + og:title / og:description / fallback extraction. */
async function handleGeneric(url: string): Promise<UrlFetchResult> {
  const fetched = await fetchWithCaps(url)
  if (!fetched.ok) {
    return {
      ok: false,
      shape: 'generic',
      title: null,
      description: null,
      imageUrl: null,
      extractedText: '',
      summaryForCoordinator: `Couldn't fetch URL: ${fetched.reason}`,
      reason: fetched.reason,
      url,
    }
  }
  const { body } = fetched
  const ogTitle = readMeta(body, 'og:title')
  const ogDescription = readMeta(body, 'og:description')
  const ogImage = readMeta(body, 'og:image')
  const title = ogTitle ?? readTitle(body)
  const description = ogDescription ?? readFirstParagraph(body)

  // If both extractions came up empty, return ok=false so the caller
  // routes the bare URL through the standard classifier instead of
  // generating a useless propose-and-confirm.
  if (!title && !description) {
    return {
      ok: false,
      shape: 'generic',
      title: null,
      description: null,
      imageUrl: ogImage,
      extractedText: '',
      summaryForCoordinator: `Fetched ${url} but couldn't extract title or description. Maybe the page is JS-rendered?`,
      reason: 'no_extractable_content',
      url,
    }
  }

  const extractedText = [title ?? '', description ?? ''].filter(Boolean).join('\n')
  const summary = buildSummary({
    shape: 'generic',
    url,
    title,
    description,
    imageUrl: ogImage,
  })
  return {
    ok: true,
    shape: 'generic',
    title,
    description,
    imageUrl: ogImage,
    extractedText,
    summaryForCoordinator: summary,
    url,
  }
}

/**
 * Public entry point — fetch + extract for a single URL, dispatched
 * by classifyUrlShape. Never throws; on failure returns ok=false.
 */
export async function fetchAndExtractUrl(url: string): Promise<UrlFetchResult> {
  const shape = classifyUrlShape(url)
  if (shape === 'pinterest') return handlePinterest(url)
  if (shape === 'google_doc') return handleGoogleDoc(url)
  return handleGeneric(url)
}
