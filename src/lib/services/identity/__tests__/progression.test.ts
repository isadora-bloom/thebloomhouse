/**
 * Wave 6 W45 — CSV anchor progression mapping. Non-HoneyBook CSV channels
 * now map crm_imported_inquiry / crm_imported_booked to the same
 * progression event types as HoneyBook, homogenising the decay clock
 * across all CSV sources (web_form, generic_csv, dubsado, aisle_planner).
 */
import { describe, it, expect } from 'vitest'
import { progressionEventTypeFor } from '../progression'
import type { NormalizedSignal } from '../sources/types'

/** The smallest signal the mapper needs; only channel and action_type matter here. */
function sig(channel: string, action_type: string): NormalizedSignal {
  return {
    external_id: `test:${channel}:${action_type}`,
    channel,
    action_type,
    occurred_at: '2026-01-01T00:00:00.000Z',
    signal_tier: 'medium',
    identity_hint: null,
    raw_payload: {},
  }
}

describe('progressionEventTypeFor — CSV anchor progression (Wave 6 W45)', () => {
  describe('HoneyBook channel (existing)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal = sig('honeybook', 'crm_imported_inquiry')
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal = sig('honeybook', 'crm_imported_booked')
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })

    it('maps crm_imported_lost to null (regression, not progression)', () => {
      const signal = sig('honeybook', 'crm_imported_lost')
      expect(progressionEventTypeFor(signal)).toBeNull()
    })
  })

  describe('web_form channel (new)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal = sig('web', 'crm_imported_inquiry')
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal = sig('web', 'crm_imported_booked')
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })
  })

  describe('generic csv_import channel (new)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal = sig('csv_import', 'crm_imported_inquiry')
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal = sig('csv_import', 'crm_imported_booked')
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })
  })

  describe('dubsado channel (new)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal = sig('dubsado', 'crm_imported_inquiry')
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal = sig('dubsado', 'crm_imported_booked')
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })
  })

  describe('aisle_planner channel (new)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal = sig('aisle_planner', 'crm_imported_inquiry')
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal = sig('aisle_planner', 'crm_imported_booked')
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })
  })
})
