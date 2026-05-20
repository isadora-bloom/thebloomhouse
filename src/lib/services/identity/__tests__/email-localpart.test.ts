/**
 * Email-localpart segmentation contract tests.
 *
 * Pins the doctrine for cascade stage 5: extract logical first / last
 * name tokens from various email localpart shapes and assert they
 * collide on the same person across different email providers.
 */

import { describe, it, expect } from 'vitest'
import {
  extractNameTokens,
  logicalLocalpartMatch,
  localpartOf,
} from '../email-localpart'

describe('localpartOf', () => {
  it('returns the part before @', () => {
    expect(localpartOf('tim@bloggs.com')).toBe('tim')
    expect(localpartOf('Tim.Smith@example.com')).toBe('tim.smith')
  })

  it('returns null for invalid inputs', () => {
    expect(localpartOf('not-an-email')).toBe(null)
    expect(localpartOf(null)).toBe(null)
    expect(localpartOf('')).toBe(null)
    expect(localpartOf('@example.com')).toBe(null)
  })
})

describe('extractNameTokens — separator split', () => {
  it('splits timmy.blogs into timmy + blogs', () => {
    const r = extractNameTokens('timmy.blogs')
    expect(r.via).toBe('separator_split')
    expect(r.firstCandidates).toContain('timmy')
    expect(r.lastCandidate).toBe('blogs')
  })

  it('splits timothy_blogs_42 into timothy + blogs (digits stripped)', () => {
    const r = extractNameTokens('timothy_blogs_42')
    expect(r.via).toBe('separator_split')
    expect(r.firstCandidates).toContain('timothy')
    expect(r.lastCandidate).toBe('blogs')
  })

  it('handles tim-smith', () => {
    const r = extractNameTokens('tim-smith')
    expect(r.firstCandidates).toContain('tim')
    expect(r.lastCandidate).toBe('smith')
  })
})

describe('extractNameTokens — dictionary prefix', () => {
  it('segments timothyblogs into timothy + blogs via dictionary', () => {
    const r = extractNameTokens('timothyblogs')
    expect(r.via).toBe('dictionary_prefix')
    expect(r.firstCandidates).toContain('timothy')
    expect(r.lastCandidate).toBe('blogs')
  })

  it('segments susanjones into susan + jones', () => {
    const r = extractNameTokens('susanjones')
    expect(r.firstCandidates).toContain('susan')
    expect(r.lastCandidate).toBe('jones')
  })

  it('returns whole-string when no dictionary prefix matches', () => {
    const r = extractNameTokens('xenoblastophilia')
    expect(r.via).toBe('whole_string')
    expect(r.lastCandidate).toBe('xenoblastophilia')
  })
})

describe('logicalLocalpartMatch', () => {
  it('matches timmy.blogs to timothyblogs', () => {
    expect(logicalLocalpartMatch('timmy.blogs', 'timothyblogs')).toBe(true)
  })

  it('matches tim.smith to timothysmith', () => {
    expect(logicalLocalpartMatch('tim.smith', 'timothysmith')).toBe(true)
  })

  it('matches sue.jones to susanjones', () => {
    expect(logicalLocalpartMatch('sue.jones', 'susanjones')).toBe(true)
  })

  it('does NOT match tim.smith to tom.smith (different first names)', () => {
    expect(logicalLocalpartMatch('tim.smith', 'tom.smith')).toBe(false)
  })

  it('does NOT match tim.smith to tim.jones (different last names)', () => {
    expect(logicalLocalpartMatch('tim.smith', 'tim.jones')).toBe(false)
  })

  it('does NOT match when one side has no clear last name', () => {
    expect(logicalLocalpartMatch('tim', 'timothyblogs')).toBe(false)
  })
})
