/**
 * Unit tests for scaffold-gate.ts (Wave 5 W39).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})

vi.mock('next/navigation', () => ({
  notFound: () => notFoundMock(),
}))

describe('assertNotScaffold', () => {
  const originalScaffold = process.env.SCAFFOLD_PAGES

  beforeEach(() => {
    notFoundMock.mockClear()
  })

  afterEach(() => {
    process.env.SCAFFOLD_PAGES = originalScaffold
  })

  it('calls notFound() when SCAFFOLD_PAGES is not set', async () => {
    delete process.env.SCAFFOLD_PAGES
    const { assertNotScaffold } = await import('../scaffold-gate')
    expect(() => assertNotScaffold('/intel/discoveries')).toThrow('NEXT_NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalledTimes(1)
  })

  it('calls notFound() when SCAFFOLD_PAGES is set to anything other than "1"', async () => {
    process.env.SCAFFOLD_PAGES = 'true'
    const { assertNotScaffold } = await import('../scaffold-gate')
    expect(() => assertNotScaffold('/intel/discoveries')).toThrow('NEXT_NOT_FOUND')
  })

  it('does not call notFound() when SCAFFOLD_PAGES=1', async () => {
    process.env.SCAFFOLD_PAGES = '1'
    const { assertNotScaffold } = await import('../scaffold-gate')
    expect(() => assertNotScaffold('/intel/discoveries')).not.toThrow()
    expect(notFoundMock).not.toHaveBeenCalled()
  })
})
