/**
 * The /demo prefix used to rewrite anything onto the real route AND mint a
 * signed demo token for it. /demo/api/<anything> was therefore a
 * credential-granting prefix over the whole API surface: no cookie, no
 * visit to /demo, just a path.
 *
 * These tests drive the real middleware, which returns before it builds a
 * Supabase client on this branch, so they need no environment.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '../../../middleware'

function get(path: string) {
  return middleware(new NextRequest(`https://app.bloomhouse.ai${path}`))
}

describe('/demo prefix never reaches the API', () => {
  beforeAll(() => {
    // signDemoToken reads this when the branch does run; set it so a
    // failure here is about routing, not about a missing secret.
    process.env.DEMO_SIGNING_SECRET ??= 'test-secret-for-middleware-tests'
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon'
  })

  it('404s /demo/api/<route>', async () => {
    for (const path of [
      '/demo/api/agent/send',
      '/demo/api/team/invite',
      '/demo/api/agent/wipe-pipeline-data?confirm=YES',
      '/demo/api',
    ]) {
      const res = await get(path)
      expect(res.status, path).toBe(404)
      // And no demo cookie was handed out on the way.
      expect(res.headers.get('set-cookie'), path).toBeNull()
    }
  })

  it('still rewrites an ordinary demo page', async () => {
    const res = await get('/demo/agent/inbox')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-rewrite')).toContain('/agent/inbox')
  })

  it('does not 404 a real route that merely starts with the letters api', async () => {
    const res = await get('/demo/apiary')
    expect(res.headers.get('x-middleware-rewrite')).toContain('/apiary')
  })
})

/**
 * A couple who cannot sign in was sent to the password-recovery page and
 * bounced straight back to the login page they could not get past, because
 * the public-route list only knew about login and register.
 */
describe('couple password recovery is public', () => {
  const redirectedToLogin = (res: Response) =>
    res.status >= 300 && res.status < 400 && (res.headers.get('location') ?? '').includes('/couple/login')

  it('lets an unauthenticated couple reach forgot-password and reset-password', async () => {
    for (const path of [
      '/couple/hawthorne-manor/forgot-password',
      '/couple/hawthorne-manor/reset-password',
      '/couple/hawthorne-manor/login',
      '/couple/hawthorne-manor/register',
      '/couple/login',
    ]) {
      const res = await get(path)
      expect(redirectedToLogin(res), path).toBe(false)
    }
  })

  it('still sends an unauthenticated couple away from the portal itself', async () => {
    const res = await get('/couple/hawthorne-manor/dashboard')
    expect(redirectedToLogin(res)).toBe(true)
  })
})
