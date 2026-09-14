/**
 * Wave 6 W45 — CSV anchor progression mapping. Non-HoneyBook CSV channels
 * now map crm_imported_inquiry / crm_imported_booked to the same
 * progression event types as HoneyBook, homogenising the decay clock
 * across all CSV sources (web_form, generic_csv, dubsado, aisle_planner).
 */
import { describe, it, expect } from 'vitest'
import { progressionEventTypeFor } from '../progression'
import type { NormalizedSignal } from '../sources/types'

describe('progressionEventTypeFor — CSV anchor progression (Wave 6 W45)', () => {
  describe('HoneyBook channel (existing)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'honeybook',
        action_type: 'crm_imported_inquiry',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'honeybook',
        action_type: 'crm_imported_booked',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })

    it('maps crm_imported_lost to null (regression, not progression)', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'honeybook',
        action_type: 'crm_imported_lost',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBeNull()
    })
  })

  describe('web_form channel (new)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'web',
        action_type: 'crm_imported_inquiry',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'web',
        action_type: 'crm_imported_booked',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })
  })

  describe('generic csv_import channel (new)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'csv_import',
        action_type: 'crm_imported_inquiry',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'csv_import',
        action_type: 'crm_imported_booked',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })
  })

  describe('dubsado channel (new)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'dubsado',
        action_type: 'crm_imported_inquiry',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'dubsado',
        action_type: 'crm_imported_booked',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })
  })

  describe('aisle_planner channel (new)', () => {
    it('maps crm_imported_inquiry to crm_inquiry', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'aisle_planner',
        action_type: 'crm_imported_inquiry',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('crm_inquiry')
    })

    it('maps crm_imported_booked to contract_signed', () => {
      const signal: NormalizedSignal = {
        occurred_at: '2026-01-01T00:00:00.000Z',
        channel: 'aisle_planner',
        action_type: 'crm_imported_booked',
        couple_id: null,
        extracted_identity: null,
        handles: null,
        source_event_id: 'test',
        raw_payload: {},
      }
      expect(progressionEventTypeFor(signal)).toBe('contract_signed')
    })
  })
})
