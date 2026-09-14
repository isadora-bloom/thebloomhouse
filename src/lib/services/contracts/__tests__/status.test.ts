/**
 * The two rules the whole workstream leans on: a signed contract cannot be
 * sent again, and a void one cannot be signed. Everything else in this file
 * is there so a future edit to the table has to say out loud what it changed.
 */

import { describe, it, expect } from 'vitest'
import {
  asContractStatus,
  canSend,
  canSign,
  canVoid,
  statusLabel,
  statusOnView,
  statusTrailLine,
} from '../status'

describe('asContractStatus', () => {
  it('reads the five generated statuses', () => {
    for (const s of ['draft', 'sent', 'viewed', 'signed', 'void']) {
      expect(asContractStatus(s)).toBe(s)
    }
  })

  it('refuses an upload status rather than guessing', () => {
    // The column is shared with uploads. 'analyzed' is a real value that
    // means nothing in this lifecycle, so it must not resolve.
    expect(asContractStatus('analyzed')).toBeNull()
    expect(asContractStatus('uploaded')).toBeNull()
    expect(asContractStatus('extracted')).toBeNull()
  })

  it('refuses anything that is not a string', () => {
    expect(asContractStatus(null)).toBeNull()
    expect(asContractStatus(undefined)).toBeNull()
    expect(asContractStatus(3)).toBeNull()
    expect(asContractStatus({ status: 'sent' })).toBeNull()
  })
})

describe('canSend', () => {
  it('allows a draft', () => {
    expect(canSend('draft').ok).toBe(true)
  })

  it('allows a re-send of something already sent or opened', () => {
    expect(canSend('sent').ok).toBe(true)
    expect(canSend('viewed').ok).toBe(true)
  })

  it('refuses a signed contract', () => {
    const result = canSend('signed')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/already signed/i)
  })

  it('refuses a withdrawn contract', () => {
    expect(canSend('void').ok).toBe(false)
  })

  it('refuses a row that is not a generated contract', () => {
    expect(canSend(null).ok).toBe(false)
  })
})

describe('canSign', () => {
  it('allows one that has been sent or opened', () => {
    expect(canSign('sent').ok).toBe(true)
    expect(canSign('viewed').ok).toBe(true)
  })

  it('refuses a draft, which has never left the building', () => {
    const result = canSign('draft')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/not been sent/i)
  })

  it('refuses a withdrawn contract', () => {
    const result = canSign('void')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/withdrawn/i)
  })

  it('refuses one that is already signed', () => {
    expect(canSign('signed').ok).toBe(false)
  })
})

describe('canVoid', () => {
  it('allows withdrawing anything not yet signed', () => {
    expect(canVoid('draft').ok).toBe(true)
    expect(canVoid('sent').ok).toBe(true)
    expect(canVoid('viewed').ok).toBe(true)
  })

  it('refuses to withdraw a signed contract', () => {
    expect(canVoid('signed').ok).toBe(false)
  })

  it('refuses to withdraw one already withdrawn', () => {
    expect(canVoid('void').ok).toBe(false)
  })
})

describe('statusOnView', () => {
  it('moves a sent contract to opened on the first read', () => {
    expect(statusOnView('sent')).toBe('viewed')
  })

  it('leaves everything else where it is', () => {
    expect(statusOnView('viewed')).toBe('viewed')
    expect(statusOnView('signed')).toBe('signed')
    expect(statusOnView('void')).toBe('void')
    expect(statusOnView('draft')).toBe('draft')
  })
})

describe('statusLabel', () => {
  it('says it in plain words', () => {
    expect(statusLabel('draft')).toBe('Not sent yet')
    expect(statusLabel('viewed')).toBe('Opened')
    expect(statusLabel('void')).toBe('Withdrawn')
  })
})

describe('statusTrailLine', () => {
  it('names who signed and when', () => {
    const line = statusTrailLine({
      status: 'signed',
      signed_at: '2026-06-12T14:00:00Z',
      signed_name: 'Chloe Barnes',
    })
    expect(line).toContain('Chloe Barnes')
    expect(line).toContain('12 June 2026')
  })

  it('reads from the real event columns, never the write time', () => {
    const line = statusTrailLine({
      status: 'sent',
      sent_at: '2026-05-01T09:00:00Z',
    })
    expect(line).toBe('Sent on 1 May 2026')
  })

  it('says nothing rather than guessing when the timestamp is missing', () => {
    expect(statusTrailLine({ status: 'sent', sent_at: null })).toBeNull()
    expect(statusTrailLine({ status: 'draft' })).toBeNull()
  })
})
