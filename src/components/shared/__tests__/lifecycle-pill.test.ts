/**
 * The one pill, rendered. W37.
 *
 * Rendered to static markup rather than mounted, because there is nothing
 * interactive to drive: the component takes a derived stage and prints it.
 * What matters is that the same derived stage produces the same words, the
 * same colour and the same tooltip no matter which surface asked, which is
 * exactly what broke when three surfaces each had their own.
 */

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LifecyclePill } from '../lifecycle-pill'
import {
  deriveOperatorStage,
  type DeriveOperatorStageInput,
} from '@/lib/services/lifecycle/vocabulary'

const TODAY = '2026-09-12T12:00:00.000Z'

function render(
  input: Partial<DeriveOperatorStageInput>,
  props: { size?: 'sm' | 'md'; showDisagreement?: boolean } = {},
): string {
  const stage = deriveOperatorStage({
    spineState: null,
    machineStage: null,
    hasBooking: false,
    weddingDate: null,
    lastInboundAt: null,
    today: TODAY,
    ...input,
  })
  return renderToStaticMarkup(createElement(LifecyclePill, { stage, ...props }))
}

describe('LifecyclePill', () => {
  it('renders the operator words, not the database value', () => {
    const html = render({ spineState: 'ghost' })
    expect(html).toContain('Gone quiet')
    expect(html).not.toContain('ghost')
  })

  it('puts the reason in the tooltip', () => {
    const html = render({ spineState: 'ghost', machineStage: 'tour_scheduled' })
    expect(html).toContain('title="')
    expect(html).toContain('pipeline')
  })

  it('carries the stage and the agreement as data attributes, for the audit to read', () => {
    const html = render({ spineState: 'booked', weddingDate: '2027-06-05' })
    expect(html).toContain('data-stage="booked"')
    expect(html).toContain('data-agreement="one_sided"')
  })

  it('gives the same stage the same colour whichever surface asked', () => {
    const fromTheList = render({ spineState: 'booked', weddingDate: '2027-06-05' })
    const fromThePipeline = render({
      spineState: 'booked',
      machineStage: 'booked',
      hasBooking: true,
      weddingDate: '2027-06-05',
    })
    const colourOf = (html: string) => /bg-[a-z]+-\d+/.exec(html)?.[0]
    expect(colourOf(fromTheList)).toBe(colourOf(fromThePipeline))
    expect(fromTheList).toContain('Booked')
    expect(fromThePipeline).toContain('Booked')
  })

  it('marks a disagreement only when asked to, and says so for a screen reader', () => {
    const disagreeing = {
      spineState: 'ghost' as const,
      machineStage: 'tour_scheduled' as const,
    }
    const shown = render(disagreeing, { showDisagreement: true })
    const hidden = render(disagreeing)
    expect(shown).toContain('the record and your pipeline disagree')
    expect(hidden).not.toContain('the record and your pipeline disagree')
    // The attribute is there either way, so a page can style or audit it.
    expect(hidden).toContain('data-agreement="disagreed"')
  })

  it('does not mark agreement as a disagreement', () => {
    const html = render(
      { spineState: 'resolved', machineStage: 'nurture' },
      { showDisagreement: true },
    )
    expect(html).toContain('In conversation')
    expect(html).toContain('data-agreement="agreed"')
    expect(html).not.toContain('the record and your pipeline disagree')
  })

  it('renders the small size the pipeline card asks for', () => {
    const small = render({ spineState: 'resolved' }, { size: 'sm' })
    const medium = render({ spineState: 'resolved' })
    expect(small).toContain('text-[10px]')
    expect(medium).toContain('text-xs')
  })

  it('never renders an empty pill', () => {
    for (const spineState of [
      'channel_scoped',
      'resolved',
      'booked',
      'completed',
      'ghost',
      'agent',
      'merged',
    ] as const) {
      const html = render({ spineState })
      expect(html).toMatch(/>[^<]*[A-Za-z][^<]*</)
    }
  })
})
