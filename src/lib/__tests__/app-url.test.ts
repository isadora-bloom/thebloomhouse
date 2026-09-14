import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appUrl } from '../app-url'

const originalEnv = process.env

describe('appUrl', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.NODE_ENV = 'production'
    // Clear all the app URL env vars
    delete process.env.APP_CANONICAL_HOST
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.VERCEL_URL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('prefers APP_CANONICAL_HOST when set', () => {
    process.env.APP_CANONICAL_HOST = 'example.com'
    process.env.NEXT_PUBLIC_APP_URL = 'https://fallback.com'
    process.env.VERCEL_URL = 'vercel-deployment.vercel.app'

    expect(appUrl('/couple/login')).toBe('https://example.com/couple/login')
  })

  it('falls back to NEXT_PUBLIC_APP_URL when canonical host not set', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://fallback.com'
    process.env.VERCEL_URL = 'vercel-deployment.vercel.app'

    expect(appUrl('/api/auth/zoom/callback')).toBe(
      'https://fallback.com/api/auth/zoom/callback'
    )
  })

  it('falls back to VERCEL_URL in production when others not set', () => {
    process.env.VERCEL_URL = 'my-deployment.vercel.app'
    process.env.NODE_ENV = 'production'

    expect(appUrl('/billing/success')).toBe(
      'https://my-deployment.vercel.app/billing/success'
    )
  })

  it('uses http in development, https in production', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.APP_CANONICAL_HOST
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.VERCEL_URL

    expect(appUrl('/test')).toBe('http://localhost:3000/test')
  })

  it('uses https in production with fallback', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.APP_CANONICAL_HOST
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.VERCEL_URL

    expect(appUrl('/test')).toBe('https://localhost:3000/test')
  })

  it('removes trailing slashes from NEXT_PUBLIC_APP_URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com///'

    expect(appUrl('/path')).toBe('https://example.com/path')
  })

  it('handles canonical host with subdomain', () => {
    process.env.APP_CANONICAL_HOST = 'sub.example.com'

    expect(appUrl('/api/webhook')).toBe('https://sub.example.com/api/webhook')
  })

  it('builds absolute URLs for email links', () => {
    process.env.APP_CANONICAL_HOST = 'example.com'

    expect(appUrl('/couple/hawthorne-manor/register?invite=abc123')).toBe(
      'https://example.com/couple/hawthorne-manor/register?invite=abc123'
    )
  })
})
