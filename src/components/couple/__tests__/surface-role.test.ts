/**
 * What each role may do with a shared couple-portal component.
 *
 * The point of writing this down as data is that the difference between
 * the two surfaces is readable in one place instead of being inferred
 * from `role === 'couple'` checks spread through two large components.
 * These tests pin the answer for both roles.
 */

import { describe, it, expect } from 'vitest'
import {
  contractCapabilities,
  timelineCapabilities,
  editorNoun,
  stampEditedBy,
  readEditedBy,
  editedByLine,
} from '../surface-role'

describe('contractCapabilities', () => {
  it('gives the couple the whole page, as it always had', () => {
    const c = contractCapabilities('couple')
    expect(c).toEqual({
      canRead: true,
      canSearch: true,
      canDownload: true,
      canUpload: true,
      canDelete: true,
      canAnalyse: true,
      canAskAssistant: true,
      canAskInline: true,
    })
  })

  it('gives the coordinator read, search and the file, and nothing that writes', () => {
    const c = contractCapabilities('coordinator')
    expect(c.canRead).toBe(true)
    expect(c.canSearch).toBe(true)
    expect(c.canDownload).toBe(true)
    expect(c.canUpload).toBe(false)
    expect(c.canDelete).toBe(false)
    expect(c.canAnalyse).toBe(false)
  })

  it('keeps the assistant chat on the couple side, because the route is couple-scoped', () => {
    expect(contractCapabilities('couple').canAskAssistant).toBe(true)
    expect(contractCapabilities('coordinator').canAskAssistant).toBe(false)
  })
})

describe('timelineCapabilities', () => {
  it('lets both roles edit and save the same running order', () => {
    for (const role of ['couple', 'coordinator'] as const) {
      const t = timelineCapabilities(role)
      expect(t.canEdit).toBe(true)
      expect(t.canSave).toBe(true)
      expect(t.canAddCustom).toBe(true)
      expect(t.canExport).toBe(true)
    }
  })

  it('keeps Reset with the couple only', () => {
    expect(timelineCapabilities('couple').canReset).toBe(true)
    expect(timelineCapabilities('coordinator').canReset).toBe(false)
  })
})

describe('attribution', () => {
  it('names the editor in plain words', () => {
    expect(editorNoun('couple')).toBe('the couple')
    expect(editorNoun('coordinator')).toBe('the coordinator')
  })

  it('stamps the role and the instant, and reads it back', () => {
    const at = new Date('2026-09-14T10:30:00.000Z')
    const stamp = stampEditedBy('coordinator', at)
    expect(stamp).toEqual({ role: 'coordinator', at: '2026-09-14T10:30:00.000Z' })
    expect(readEditedBy(stamp)).toEqual(stamp)
  })

  it('round-trips the couple stamp too', () => {
    const stamp = stampEditedBy('couple', new Date('2026-09-01T00:00:00.000Z'))
    expect(readEditedBy(JSON.parse(JSON.stringify(stamp)))).toEqual(stamp)
  })

  it('returns null rather than guessing when the blob predates the stamp', () => {
    expect(readEditedBy(undefined)).toBeNull()
    expect(readEditedBy(null)).toBeNull()
    expect(readEditedBy('coordinator')).toBeNull()
    expect(readEditedBy([{ role: 'couple', at: 'x' }])).toBeNull()
    expect(readEditedBy({ role: 'planner', at: '2026-09-14T00:00:00.000Z' })).toBeNull()
    expect(readEditedBy({ role: 'couple' })).toBeNull()
    expect(readEditedBy({ role: 'couple', at: '  ' })).toBeNull()
  })

  it('drops the line entirely when nothing has been stamped', () => {
    expect(editedByLine(null)).toBeNull()
    expect(editedByLine({ role: 'coordinator', at: '2026-09-14T00:00:00.000Z' }))
      .toBe('Last saved by the coordinator')
  })
})
