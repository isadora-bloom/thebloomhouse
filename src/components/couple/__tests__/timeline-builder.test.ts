/**
 * The shared day-of timeline, rendered for both roles.
 *
 * The builder itself is a large stateful component; what differs between
 * the two surfaces is the chrome around it, which is what these render.
 * The couple keeps their page heading and the Reset button. The
 * coordinator gets the same edit and save, is told plainly that saving
 * lands in front of the couple, and is not handed a Reset that would wipe
 * an evening of the couple's work with no undo.
 */

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TimelineBuilderHeader, TimelineSaveBar } from '../timeline-builder'
import { timelineCapabilities, type CoupleSurfaceRole } from '../surface-role'

const NOOP = () => {}

function header(
  role: CoupleSurfaceRole,
  opts: { sunsetTime?: string | null; editedBy?: { role: CoupleSurfaceRole; at: string } | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(TimelineBuilderHeader, {
      role,
      caps: timelineCapabilities(role),
      sunsetTime: opts.sunsetTime ?? null,
      editedBy: opts.editedBy ?? null,
      canExport: true,
      onExport: NOOP,
    }),
  )
}

function saveBar(role: CoupleSurfaceRole, saving = false): string {
  return renderToStaticMarkup(
    createElement(TimelineSaveBar, { role, saving, onDiscard: NOOP, onSave: NOOP }),
  )
}

describe('TimelineBuilderHeader', () => {
  it('keeps the couple page heading on the couple page', () => {
    const html = header('couple')
    expect(html).toContain('Your Wedding Timeline')
    expect(html).toContain('getting ready to the grand exit')
  })

  it('drops the page heading on the wedding page, where the section already has one', () => {
    const html = header('coordinator')
    expect(html).not.toContain('Your Wedding Timeline')
    expect(html.includes('<h1')).toBe(false)
  })

  it('tells the coordinator where a save lands', () => {
    expect(header('coordinator')).toContain('same place their portal reads from')
  })

  it('gives both roles the CSV export', () => {
    expect(header('couple')).toContain('Export CSV')
    expect(header('coordinator')).toContain('Export CSV')
  })

  it('prints the sunset for both roles when the venue has coordinates', () => {
    for (const role of ['couple', 'coordinator'] as const) {
      expect(header(role, { sunsetTime: '19:42' })).toContain('Sunset at')
    }
  })

  it('says who saved it last, or says nothing at all', () => {
    const stamped = header('coordinator', {
      editedBy: { role: 'coordinator', at: '2026-09-14T10:00:00.000Z' },
    })
    expect(stamped).toContain('Last saved by the coordinator')

    const byCouple = header('coordinator', {
      editedBy: { role: 'couple', at: '2026-09-01T10:00:00.000Z' },
    })
    expect(byCouple).toContain('Last saved by the couple')

    expect(header('coordinator')).not.toContain('Last saved by')
  })
})

describe('TimelineSaveBar', () => {
  it('offers the same save to both roles', () => {
    expect(saveBar('couple')).toContain('Save Timeline')
    expect(saveBar('coordinator')).toContain('Save Timeline')
  })

  it('warns the coordinator that a save is immediately visible to the couple', () => {
    expect(saveBar('couple')).toContain('You have unsaved changes')
    expect(saveBar('coordinator')).toContain('in front of the couple')
  })

  it('shows the in-flight state for both roles', () => {
    expect(saveBar('couple', true)).toContain('Saving...')
    expect(saveBar('coordinator', true)).toContain('Saving...')
  })
})

describe('timeline capabilities on the two surfaces', () => {
  it('withholds Reset from the coordinator, and only Reset', () => {
    const couple = timelineCapabilities('couple')
    const coordinator = timelineCapabilities('coordinator')
    const differing = (Object.keys(couple) as Array<keyof typeof couple>)
      .filter((k) => couple[k] !== coordinator[k])
    expect(differing).toEqual(['canReset'])
  })
})
