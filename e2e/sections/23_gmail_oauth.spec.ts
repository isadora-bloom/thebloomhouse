import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  signGmailOAuthState,
} from '../../src/lib/services/email/gmail-oauth-state'

/**
 * §23 Gmail OAuth (PROJECT-AUDIT-V2 GAP-13).
 *
 * Three behaviours we must guarantee:
 *   a) Tampered state token → callback rejects with bad_state_bad_signature
 *      and writes NOTHING to gmail_connections.
 *   b) Re-connecting the same Gmail address UPDATEs the existing row
 *      (idempotent on (venue_id, email_address)) instead of inserting a
 *      duplicate.
 *   c) DELETE on /api/gmail/connections/:id/disconnect actually removes
 *      the row and returns ok:true.
 *
 * Because we can't drive Google's consent screen from Playwright, the
 * tests use the service-role client to seed gmail_connections rows and
 * the HMAC state helper to mint tampered/valid tokens. The disconnect
 * test calls the real route while authenticated as the demo
 * coordinator (the bloom_demo cookie short-circuits getPlatformAuth to
 * the Hawthorne demo venue).
 */

const TAG = '[e2e:23-gmail-oauth]'
const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'
const DEMO_USER_ID = '33333333-3333-3333-3333-333333333301'
const BASE_URL =
  process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT ?? 3100}`

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return _admin
}

async function cleanupTaggedRows() {
  // We tag rows by writing TAG into the label field so cleanup is precise.
  await admin().from('gmail_connections').delete().eq('venue_id', DEMO_VENUE_ID).ilike('label', `%${TAG}%`)
}

const skipReason = (() => {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return 'Supabase env not set'
  }
  if (!process.env.STATE_SIGNING_SECRET || process.env.STATE_SIGNING_SECRET.length < 16) {
    return 'STATE_SIGNING_SECRET not configured'
  }
  return null
})()

test.describe('§23 Gmail OAuth — state + idempotency + revoke', () => {
  test.skip(!!skipReason, skipReason ?? '')

  test.beforeEach(async () => {
    await cleanupTaggedRows()
  })

  test.afterAll(async () => {
    await cleanupTaggedRows()
  })

  test('a) tampered state token is rejected and writes nothing', async ({ request }) => {
    const valid = signGmailOAuthState({
      venueId: DEMO_VENUE_ID,
      userId: DEMO_USER_ID,
      returnTo: '/settings/gmail',
    })
    // Tamper the signature: flip the last character.
    const tampered =
      valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A')

    const before = await admin()
      .from('gmail_connections')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', DEMO_VENUE_ID)
    const beforeCount = before.count ?? 0

    const res = await request.get(
      `${BASE_URL}/api/gmail/oauth/callback?code=fake-code&state=${encodeURIComponent(tampered)}`,
      { maxRedirects: 0 },
    )
    // Expect a redirect — not a 5xx — and the redirect URL carries
    // gmail=error&reason=bad_state_bad_signature.
    expect([301, 302, 303, 307, 308]).toContain(res.status())
    const location = res.headers()['location'] ?? ''
    expect(location).toContain('gmail=error')
    expect(location).toContain('reason=bad_state_bad_signature')

    // No row should have been created.
    const after = await admin()
      .from('gmail_connections')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', DEMO_VENUE_ID)
    expect(after.count ?? 0).toBe(beforeCount)
  })

  test('a2) expired state token is rejected', async ({ request }) => {
    // Hand-mint an expired token: sign payload with ts = now - 1 hour.
    // We can't use signGmailOAuthState directly (it stamps now()), but
    // verify path treats > 10min as expired regardless of clock skew.
    // Cheat: sign a fresh token, then manually rebuild with old ts.
    const { createHmac, randomBytes } = await import('node:crypto')
    const secret = process.env.STATE_SIGNING_SECRET!
    const payload = {
      venueId: DEMO_VENUE_ID,
      userId: DEMO_USER_ID,
      nonce: randomBytes(16).toString('hex'),
      ts: Date.now() - 60 * 60 * 1000, // 1 hour ago
      returnTo: '/settings/gmail',
    }
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
    const sig = createHmac('sha256', Buffer.from(secret, 'utf-8'))
      .update(payloadB64)
      .digest('base64url')
    const expired = `${payloadB64}.${sig}`

    const res = await request.get(
      `${BASE_URL}/api/gmail/oauth/callback?code=fake&state=${encodeURIComponent(expired)}`,
      { maxRedirects: 0 },
    )
    expect([301, 302, 303, 307, 308]).toContain(res.status())
    const location = res.headers()['location'] ?? ''
    expect(location).toContain('reason=bad_state_expired')
  })

  test('b) re-connecting the same Gmail UPDATEs, never inserts a duplicate', async () => {
    const email = 'idempotency-target@example.com'

    // Seed the initial row directly (simulates a prior successful OAuth).
    const { data: first, error: firstErr } = await admin()
      .from('gmail_connections')
      .insert({
        venue_id: DEMO_VENUE_ID,
        user_id: DEMO_USER_ID,
        email_address: email,
        gmail_tokens: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          expiry_date: Date.now() + 3600 * 1000,
          token_type: 'Bearer',
          scope: '',
        },
        is_primary: false,
        sync_enabled: true,
        status: 'active',
        label: `seed ${TAG}`,
      })
      .select('id, gmail_tokens')
      .single()
    expect(firstErr).toBeNull()
    expect(first).toBeTruthy()
    const firstId = first!.id as string

    // Now upsert with the same (venue_id, email_address) — what the
    // callback does when the user reconnects. The unique index
    // gmail_connections_venue_id_email_address_key (from migration 050)
    // makes this hit ON CONFLICT.
    const { error: upsertErr } = await admin()
      .from('gmail_connections')
      .upsert(
        {
          venue_id: DEMO_VENUE_ID,
          user_id: DEMO_USER_ID,
          email_address: email,
          gmail_tokens: {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expiry_date: Date.now() + 3600 * 1000,
            token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
          },
          is_primary: false,
          sync_enabled: true,
          status: 'active',
          label: `seed ${TAG}`,
        },
        { onConflict: 'venue_id,email_address' },
      )
    expect(upsertErr).toBeNull()

    // Exactly one row for that (venue_id, email_address).
    const { data: rows } = await admin()
      .from('gmail_connections')
      .select('id, gmail_tokens')
      .eq('venue_id', DEMO_VENUE_ID)
      .eq('email_address', email)
    expect(rows).not.toBeNull()
    expect(rows!.length).toBe(1)
    expect(rows![0].id).toBe(firstId) // same row id, not a fresh insert
    const tokens = rows![0].gmail_tokens as { access_token: string }
    expect(tokens.access_token).toBe('new-access')
  })

  test('c) DELETE /api/gmail/connections/:id/disconnect deletes the row', async ({ request }) => {
    // Seed a row.
    const email = 'revoke-target@example.com'
    const { data: seeded, error: seedErr } = await admin()
      .from('gmail_connections')
      .insert({
        venue_id: DEMO_VENUE_ID,
        user_id: DEMO_USER_ID,
        email_address: email,
        gmail_tokens: {
          access_token: 'fake-access',
          // No real refresh token — the route still attempts revoke,
          // Google returns 400, we treat as done. That keeps the test
          // hermetic (no real network call to Google succeeds).
          refresh_token: 'fake-refresh-' + Date.now(),
          expiry_date: Date.now() + 3600 * 1000,
          token_type: 'Bearer',
          scope: '',
        },
        is_primary: false,
        sync_enabled: true,
        status: 'active',
        label: `seed ${TAG}`,
      })
      .select('id')
      .single()
    expect(seedErr).toBeNull()
    const connId = seeded!.id as string

    // Hit the route as the demo coordinator (bloom_demo cookie).
    const res = await request.delete(
      `${BASE_URL}/api/gmail/connections/${connId}/disconnect`,
      {
        headers: { Cookie: 'bloom_demo=true' },
      },
    )
    expect(res.ok()).toBeTruthy()
    const json = await res.json()
    expect(json.ok).toBe(true)

    // Row is gone.
    const { data: after } = await admin()
      .from('gmail_connections')
      .select('id')
      .eq('id', connId)
      .maybeSingle()
    expect(after).toBeNull()
  })

  test('c2) disconnect rejects rows from a different venue (forbidden)', async ({ request }) => {
    // Seed a row on a venue OTHER than the demo venue, then try to
    // disconnect it as the demo coordinator. Should 403.
    // Use a Crestwood sibling venue (also allowlisted but the auth helper
    // resolves the demo cookie to Hawthorne specifically).
    const otherVenue = '22222222-2222-2222-2222-222222222202'
    const email = 'wrong-venue@example.com'
    const { data: seeded } = await admin()
      .from('gmail_connections')
      .insert({
        venue_id: otherVenue,
        user_id: DEMO_USER_ID,
        email_address: email,
        gmail_tokens: {
          access_token: 'x',
          refresh_token: 'y',
          expiry_date: Date.now() + 3600 * 1000,
          token_type: 'Bearer',
          scope: '',
        },
        is_primary: false,
        sync_enabled: true,
        status: 'active',
        label: `seed ${TAG}`,
      })
      .select('id')
      .single()

    const res = await request.delete(
      `${BASE_URL}/api/gmail/connections/${seeded!.id}/disconnect`,
      { headers: { Cookie: 'bloom_demo=true' } },
    )
    expect(res.status()).toBe(403)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.reason).toBe('forbidden')

    // Cleanup the other-venue row we seeded.
    await admin().from('gmail_connections').delete().eq('id', seeded!.id)
  })
})
