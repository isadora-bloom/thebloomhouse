import { describe, it, expect } from 'vitest'
import { classifyProviderError } from '@/lib/ai/client'

describe('classifyProviderError (Failure three)', () => {
  it('treats 429 as rate_limit', () => {
    expect(classifyProviderError({ status: 429 })).toBe('rate_limit')
  })

  it('treats 5xx and 408/409 as retryable', () => {
    expect(classifyProviderError({ status: 500 })).toBe('retryable')
    expect(classifyProviderError({ status: 503 })).toBe('retryable')
    expect(classifyProviderError({ status: 408 })).toBe('retryable')
    expect(classifyProviderError({ status: 409 })).toBe('retryable')
  })

  it('treats a network error (no HTTP status) as retryable', () => {
    expect(classifyProviderError(new Error('ECONNRESET'))).toBe('retryable')
    expect(classifyProviderError({})).toBe('retryable')
    expect(classifyProviderError({ status: 'nope' })).toBe('retryable')
  })

  it('treats non-retryable 4xx as fatal', () => {
    expect(classifyProviderError({ status: 400 })).toBe('fatal')
    expect(classifyProviderError({ status: 401 })).toBe('fatal')
    expect(classifyProviderError({ status: 403 })).toBe('fatal')
    expect(classifyProviderError({ status: 404 })).toBe('fatal')
    expect(classifyProviderError({ status: 422 })).toBe('fatal')
  })
})
