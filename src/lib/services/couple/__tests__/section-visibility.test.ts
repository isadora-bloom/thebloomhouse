import { describe, it, expect } from 'vitest'
import { isSlugOpen, sectionKeyForSlug, slugFromPathname } from '../section-visibility'

const open = [
  { section_key: 'guests', label: 'Guest List & RSVP', release_at: null },
  { section_key: 'seating', label: 'Seating Chart', release_at: '2099-01-01T00:00:00Z' },
  { section_key: 'timeline', label: 'Timeline', release_at: '2020-01-01T00:00:00Z' },
]

describe('isSlugOpen', () => {
  it('opens a section the venue has on with no release date', () => {
    expect(isSlugOpen('guests', open)).toBe(true)
    expect(isSlugOpen('rsvp-settings', open)).toBe(true) // belongs to guests
  })
  it('keeps a section closed until its release date', () => {
    expect(isSlugOpen('seating', open)).toBe(false)
    expect(isSlugOpen('table-map', open)).toBe(false)
    expect(isSlugOpen('timeline', open)).toBe(true)
  })
  it('hides a section the venue has switched off', () => {
    expect(isSlugOpen('budget', open)).toBe(false)
  })
  it('never gates the home page, account pages or the notes page', () => {
    for (const slug of ['', 'login', 'privacy', 'notes', 'whats-next']) expect(isSlugOpen(slug, open)).toBe(true)
  })
  it('does not flash a gate before the config has loaded', () => {
    expect(isSlugOpen('budget', null)).toBe(true)
  })
  it('leaves a route with no section entry open', () => {
    expect(isSlugOpen('some-new-page', open)).toBe(true)
    expect(sectionKeyForSlug('some-new-page')).toBeNull()
  })
})

describe('slugFromPathname', () => {
  it('reads the first segment after the base', () => {
    expect(slugFromPathname('/couple/hawthorne-manor/guests/import', '/couple/hawthorne-manor')).toBe('guests')
    expect(slugFromPathname('/couple/hawthorne-manor', '/couple/hawthorne-manor')).toBe('')
    expect(slugFromPathname('/seating', '')).toBe('seating')
  })
})
