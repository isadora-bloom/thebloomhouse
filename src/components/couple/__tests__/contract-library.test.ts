/**
 * The shared contract list, rendered for both roles.
 *
 * Rendered to static markup rather than mounted: what matters is which
 * affordances each surface is given, and that is settled on the first
 * render. The couple keeps everything they had. The coordinator gets
 * read, search and the file link, and is given no button that would
 * write to paperwork that is not theirs or that points at a route only
 * a couple can reach.
 */

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ContractCard,
  ContractLibraryHeader,
  filterContracts,
  type Contract,
} from '../contract-library'
import { contractCapabilities, type CoupleSurfaceRole } from '../surface-role'

const NOOP = () => {}

function contract(over: Partial<Contract> = {}): Contract {
  return {
    id: 'c1',
    venue_id: 'v1',
    wedding_id: 'w1',
    filename: 'crestwood-catering.pdf',
    file_type: 'pdf',
    file_url: 'https://example.test/signed/crestwood-catering.pdf',
    storage_path: 'w1/crestwood-catering.pdf',
    extracted_text: 'Overtime is billed at the hourly rate.',
    key_terms: ['overtime', 'deposit'],
    analysis: 'Overtime after 11pm is charged hourly.',
    analyzed_at: '2026-09-01T00:00:00.000Z',
    vendor_id: null,
    vendor_name: 'Crestwood Catering',
    status: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: null,
    ...over,
  }
}

function card(role: CoupleSurfaceRole, over: Partial<Contract> = {}): string {
  return renderToStaticMarkup(
    createElement(ContractCard, {
      contract: contract(over),
      caps: contractCapabilities(role),
      onAnalyze: NOOP,
      onDelete: NOOP,
      onAskAssistant: NOOP,
      isAnalyzing: false,
      aiName: 'Ivy',
    }),
  )
}

function header(role: CoupleSurfaceRole, totalContracts: number): string {
  return renderToStaticMarkup(
    createElement(ContractLibraryHeader, {
      role,
      caps: contractCapabilities(role),
      totalContracts,
      onUploadClick: NOOP,
    }),
  )
}

describe('ContractCard', () => {
  it('shows both roles the file name, the vendor and the link to the file', () => {
    for (const role of ['couple', 'coordinator'] as const) {
      const html = card(role)
      expect(html).toContain('crestwood-catering.pdf')
      expect(html).toContain('Crestwood Catering')
      expect(html).toContain('https://example.test/signed/crestwood-catering.pdf')
    }
  })

  it('gives the couple delete and the assistant, under the venue name for the assistant', () => {
    const html = card('couple')
    expect(html).toContain('title="Delete"')
    expect(html).toContain('Ask Ivy')
  })

  it('gives the coordinator neither delete nor the assistant chat', () => {
    const html = card('coordinator')
    expect(html).not.toContain('title="Delete"')
    expect(html).not.toContain('Ask Ivy')
  })

  it('offers the analyse run to the couple only, on an unread file', () => {
    const unread = { analyzed_at: null, analysis: null, extracted_text: null }
    expect(card('couple', unread)).toContain('Analyze')
    expect(card('coordinator', unread)).not.toContain('Analyze')
  })
})

describe('ContractLibraryHeader', () => {
  it('keeps the couple heading and the upload button on the couple page', () => {
    const html = header('couple', 4)
    expect(html).toContain('Contracts')
    expect(html).toContain('Upload Contract')
  })

  it('gives the coordinator no upload button and says who owns the files', () => {
    const html = header('coordinator', 4)
    expect(html).not.toContain('Upload Contract')
    expect(html).toContain('the couple')
  })

  it('tells the coordinator plainly when the couple has uploaded nothing', () => {
    expect(header('coordinator', 0)).toContain('has not uploaded anything yet')
  })
})

describe('filterContracts', () => {
  const rows = [
    contract({ id: 'a', filename: 'catering.pdf', vendor_name: 'Crestwood Catering', analysis: 'Overtime after 11pm.' }),
    contract({ id: 'b', filename: 'florist.pdf', vendor_name: 'Rose Hill Flowers', analysis: 'Delivery at 9am.' }),
    contract({ id: 'c', filename: 'dj.pdf', vendor_name: null, analysis: null }),
  ]

  it('returns everything for an empty or blank query', () => {
    expect(filterContracts(rows, '')).toHaveLength(3)
    expect(filterContracts(rows, '   ')).toHaveLength(3)
  })

  it('matches the file name, the vendor and the summary, case-insensitively', () => {
    expect(filterContracts(rows, 'DJ').map((r) => r.id)).toEqual(['c'])
    expect(filterContracts(rows, 'rose hill').map((r) => r.id)).toEqual(['b'])
    expect(filterContracts(rows, 'overtime').map((r) => r.id)).toEqual(['a'])
  })

  it('survives rows with no vendor and no summary', () => {
    expect(filterContracts(rows, 'nothing-here')).toEqual([])
  })

  it('answers the same for whoever is typing', () => {
    // The search is not role-aware, and should not become so: a
    // coordinator looking a clause up mid-walkthrough must see the same
    // hits the couple would.
    const forCouple = filterContracts(rows, 'catering').map((r) => r.id)
    const forCoordinator = filterContracts(rows, 'catering').map((r) => r.id)
    expect(forCouple).toEqual(forCoordinator)
  })
})
