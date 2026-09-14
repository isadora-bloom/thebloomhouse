/**
 * S4a / 2026-09-14 ingestion audit item 9.
 *
 * The brain-dump attachment path is parsed out of the coordinator's own
 * typed note, and the download runs on the SERVICE client, so RLS is not
 * standing behind it. Before this, a note carrying another venue's
 * storage prefix would have pulled that venue's file out of the shared
 * bucket and fed it to the classifier.
 *
 * `isPathInsideVenue` is the confinement rule. It is exported from the
 * route so both the POST path and the resolve path use the same one.
 */

import { describe, it, expect } from 'vitest'
import { isPathInsideVenue } from '@/app/api/brain-dump/route'

const VENUE = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

describe('isPathInsideVenue', () => {
  it('accepts the shape the uploader actually writes', () => {
    expect(isPathInsideVenue(`${VENUE}/abcd-1234-Rixey (1).csv`, VENUE)).toBe(true)
    expect(isPathInsideVenue(`${VENUE}/nested/dir/file.csv`, VENUE)).toBe(true)
  })

  it('refuses another venue prefix', () => {
    expect(isPathInsideVenue(`${OTHER}/their-export.csv`, VENUE)).toBe(false)
  })

  it('refuses a prefix that merely starts with the venue id', () => {
    expect(isPathInsideVenue(`${VENUE}-evil/their-export.csv`, VENUE)).toBe(false)
  })

  it('refuses traversal out of the prefix', () => {
    expect(isPathInsideVenue(`${VENUE}/../${OTHER}/x.csv`, VENUE)).toBe(false)
    expect(isPathInsideVenue(`..%2f${OTHER}/x.csv`, VENUE)).toBe(false)
    expect(isPathInsideVenue(`${VENUE}/./x.csv`, VENUE)).toBe(false)
  })

  it('refuses an absolute or backslash path', () => {
    expect(isPathInsideVenue(`/${VENUE}/x.csv`, VENUE)).toBe(false)
    expect(isPathInsideVenue(`${VENUE}\\..\\${OTHER}\\x.csv`, VENUE)).toBe(false)
  })

  it('refuses the bare prefix with no file', () => {
    expect(isPathInsideVenue(VENUE, VENUE)).toBe(false)
    expect(isPathInsideVenue(`${VENUE}/`, VENUE)).toBe(false)
  })

  it('refuses empty and missing input rather than defaulting open', () => {
    expect(isPathInsideVenue('', VENUE)).toBe(false)
    expect(isPathInsideVenue(null, VENUE)).toBe(false)
    expect(isPathInsideVenue(undefined, VENUE)).toBe(false)
    expect(isPathInsideVenue(`${VENUE}/x.csv`, '')).toBe(false)
  })
})
