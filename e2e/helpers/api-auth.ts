/**
 * API auth helper for E2E tests.
 *
 * Signs in via Supabase GoTrue password grant (no browser UI load) and writes
 * the session into cookies matching the exact format @supabase/ssr expects:
 *
 *   Cookie name:   sb-<project-ref>-auth-token  (chunked .0/.1 if oversize)
 *   Cookie value:  "base64-" + base64url(JSON.stringify(session))
 *
 * This matches createServerClient's default `cookieEncoding: 'base64url'` and
 * lets createServerSupabaseClient().auth.getUser() succeed on the first call
 * without the client needing to refresh the session. The session JSON is the
 * full Session shape (access_token, refresh_token, expires_at, expires_in,
 * token_type, user) — same shape gotrue-js writes via storage.setItem.
 *
 * Chunking: @supabase/ssr chunks at MAX_CHUNK_SIZE=3180 (encodeURIComponent
 * length). We mirror that logic in chunkForCookies().
 */
import { Browser, BrowserContext, APIRequestContext } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

export type ApiAuthHandle = {
  context: BrowserContext
  request: APIRequestContext
  close: () => Promise<void>
}

const MAX_CHUNK_SIZE = 3180 // matches @supabase/ssr utils/chunker.js

function projectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const m = url.match(/https?:\/\/([^.]+)\.supabase\.co/)
  if (!m) throw new Error(`Could not extract project ref from ${url}`)
  return m[1]
}

function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf-8').toString('base64url')
}

/**
 * Replicates @supabase/ssr's createChunks: encodeURIComponent, slice at
 * 3180-char boundaries safely at unicode escape boundaries, yield { name, value }.
 * If the value fits in one chunk, returns a single { name: key, value } entry.
 */
function chunkForCookies(key: string, value: string): { name: string; value: string }[] {
  const encodedValue = encodeURIComponent(value)
  if (encodedValue.length <= MAX_CHUNK_SIZE) {
    return [{ name: key, value }]
  }
  const chunks: string[] = []
  let remaining = encodedValue
  while (remaining.length > 0) {
    let head = remaining.slice(0, MAX_CHUNK_SIZE)
    const lastEscape = head.lastIndexOf('%')
    if (lastEscape > MAX_CHUNK_SIZE - 3) head = head.slice(0, lastEscape)
    // Walk back unicode-boundary safe
    let decoded = ''
    while (head.length > 0) {
      try {
        decoded = decodeURIComponent(head)
        break
      } catch {
        head = head.slice(0, head.length - 3)
      }
    }
    chunks.push(decoded)
    remaining = remaining.slice(head.length)
  }
  return chunks.map((v, i) => ({ name: `${key}.${i}`, value: v }))
}

export async function loginAsApi(
  browser: Browser,
  _role: string,
  creds: { email: string; password: string },
  opts: { venueId?: string } = {}
): Promise<ApiAuthHandle> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supabase = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await supabase.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  })
  if (error || !data.session) {
    throw new Error(`loginAsApi: signIn failed — ${error?.message ?? 'no session'}`)
  }
  const session = data.session

  const ref = projectRef()
  const key = `sb-${ref}-auth-token`

  // @supabase/ssr base64url-encodes the storage value and prefixes with 'base64-'.
  const raw = JSON.stringify(session)
  const encoded = 'base64-' + toBase64Url(raw)

  const chunks = chunkForCookies(key, encoded)

  const context = await browser.newContext()
  await context.clearCookies()

  const cookies: Parameters<BrowserContext['addCookies']>[0] = chunks.map((c) => ({
    name: c.name,
    value: c.value,
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  }))
  if (opts.venueId) {
    cookies.push({
      name: 'bloom_venue',
      value: opts.venueId,
      domain: 'localhost',
      path: '/',
    })
  }
  await context.addCookies(cookies)

  return {
    context,
    request: context.request,
    close: async () => {
      await context.close().catch(() => null)
    },
  }
}
