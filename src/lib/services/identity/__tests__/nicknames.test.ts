/**
 * Nickname dictionary contract tests.
 *
 * Pins the doctrine that the cascade stage 3 relies on: bidirectional
 * mapping, case insensitivity, and the specific high-value pairs the
 * audit (2026-05-20) identified.
 */

import { describe, it, expect } from 'vitest'
import { nicknameEquivalent, nicknamesFor, knownNameTokens } from '../nicknames'

describe('nicknames — equivalence', () => {
  it('Tim ↔ Timothy', () => {
    expect(nicknameEquivalent('Tim', 'Timothy')).toBe(true)
    expect(nicknameEquivalent('Timothy', 'Tim')).toBe(true)
  })

  it('Timmy ↔ Timothy', () => {
    expect(nicknameEquivalent('Timmy', 'Timothy')).toBe(true)
  })

  it('Sue ↔ Susan', () => {
    expect(nicknameEquivalent('Sue', 'Susan')).toBe(true)
  })

  it('Bob ↔ Robert', () => {
    expect(nicknameEquivalent('Bob', 'Robert')).toBe(true)
  })

  it('Liz ↔ Elizabeth', () => {
    expect(nicknameEquivalent('Liz', 'Elizabeth')).toBe(true)
    expect(nicknameEquivalent('Beth', 'Elizabeth')).toBe(true)
  })

  it('Paco ↔ Francisco (Spanish)', () => {
    expect(nicknameEquivalent('Paco', 'Francisco')).toBe(true)
  })

  it('Nacho ↔ Ignacio (Spanish)', () => {
    expect(nicknameEquivalent('Nacho', 'Ignacio')).toBe(true)
  })

  it('Priya ↔ Priyanka (South-Asian short form)', () => {
    expect(nicknameEquivalent('Pri', 'Priya')).toBe(true)
    expect(nicknameEquivalent('Pri', 'Priyanka')).toBe(true)
  })

  it('Same name is equivalent to itself', () => {
    expect(nicknameEquivalent('Sarah', 'Sarah')).toBe(true)
    expect(nicknameEquivalent('sarah', 'Sarah')).toBe(true)
  })

  it('Distinct names are NOT equivalent', () => {
    expect(nicknameEquivalent('Kayla', 'Makayla')).toBe(false)
    expect(nicknameEquivalent('Joel', 'Joelle')).toBe(false)
    expect(nicknameEquivalent('Hannah', 'Anna')).toBe(false)
    expect(nicknameEquivalent('Susan', 'Susannah')).toBe(false) // intentional — different names despite shared root
  })

  it('Returns false on empty inputs', () => {
    expect(nicknameEquivalent('', 'Tim')).toBe(false)
    expect(nicknameEquivalent('Tim', '')).toBe(false)
    expect(nicknameEquivalent(null, 'Tim')).toBe(false)
  })
})

describe('nicknames — alias set', () => {
  it('includes the input + all aliases', () => {
    const set = nicknamesFor('Timothy')
    expect(set.has('timothy')).toBe(true)
    expect(set.has('tim')).toBe(true)
    expect(set.has('timmy')).toBe(true)
  })

  it('returns a singleton for an unknown name', () => {
    const set = nicknamesFor('Xeniaslav')
    expect(set.size).toBe(1)
    expect(set.has('xeniaslav')).toBe(true)
  })
})

describe('nicknames — known token set', () => {
  it('includes the canonical names', () => {
    const known = knownNameTokens()
    expect(known.has('timothy')).toBe(true)
    expect(known.has('tim')).toBe(true)
    expect(known.has('elizabeth')).toBe(true)
    expect(known.has('paco')).toBe(true)
  })
})
