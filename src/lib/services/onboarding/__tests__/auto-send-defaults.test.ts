/**
 * Unit tests for createDefaultAutoSendRules (T5-W5).
 *
 * Proves the fix for "a venue with zero auto_send_rules had no way to
 * ever create one" — /agent/settings only ever UPDATEd existing rows.
 * Also pins the two migration-driven defaults this function exists to
 * get right: confidence_threshold=85 (migration 121 rescaled the
 * column to INTEGER 0-100; a stray 0.85 float fires at ~1% confidence)
 * and shadow_mode=true (migration 227's "new rules default to shadow"
 * convention).
 *
 * All Supabase access is mocked. No network traffic.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createDefaultAutoSendRules,
  DEFAULT_AUTO_SEND_SOURCES,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from '../auto-send-defaults'

const VENUE_ID = 'venue-uuid-5678'

function makeSupabaseMock(upsertResult: { data?: unknown[] | null; error?: { message: string; code?: string } | null }) {
  const selectMock = vi.fn().mockResolvedValue(upsertResult)
  const upsertMock = vi.fn().mockReturnValue({ select: selectMock })
  const fromMock = vi.fn().mockReturnValue({ upsert: upsertMock })
  return {
    sb: { from: fromMock } as unknown as import('@supabase/supabase-js').SupabaseClient,
    fromMock,
    upsertMock,
    selectMock,
  }
}

describe('createDefaultAutoSendRules', () => {
  it('seeds one row per default source with confidence_threshold=85 (not 0.85) and shadow_mode=true', async () => {
    const { sb, fromMock, upsertMock } = makeSupabaseMock({ data: DEFAULT_AUTO_SEND_SOURCES.map((_, i) => ({ id: `row-${i}` })), error: null })

    const result = await createDefaultAutoSendRules(sb, VENUE_ID)

    expect(fromMock).toHaveBeenCalledWith('auto_send_rules')
    expect(upsertMock).toHaveBeenCalledTimes(1)
    const [rows, opts] = upsertMock.mock.calls[0] as [Array<Record<string, unknown>>, { onConflict: string }]

    expect(opts).toEqual({ onConflict: 'venue_id,context,source' })
    expect(rows).toHaveLength(DEFAULT_AUTO_SEND_SOURCES.length)
    for (const row of rows) {
      expect(row.venue_id).toBe(VENUE_ID)
      expect(row.context).toBe('inquiry')
      expect(row.enabled).toBe(false)
      // The regression this test pins: migration 121 made this an
      // INTEGER 0-100 column. A float like 0.85 rounds/truncates to 0
      // or 1 -> an enabled rule would fire at ~1% confidence.
      expect(row.confidence_threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD)
      expect(row.confidence_threshold).toBe(85)
      expect(Number.isInteger(row.confidence_threshold)).toBe(true)
      // Migration 227: new rules default to shadow (observe + log,
      // don't fire) for a probationary period.
      expect(row.shadow_mode).toBe(true)
      expect(row.shadow_started_at).toEqual(expect.any(String))
    }
    expect(rows.map((r) => r.source).sort()).toEqual([...DEFAULT_AUTO_SEND_SOURCES].sort())

    expect(result).toEqual({ ok: true, created: DEFAULT_AUTO_SEND_SOURCES.length })
  })

  it('is idempotent via upsert onConflict — a second call does not error', async () => {
    const { sb } = makeSupabaseMock({ data: DEFAULT_AUTO_SEND_SOURCES.map((_, i) => ({ id: `row-${i}` })), error: null })
    const first = await createDefaultAutoSendRules(sb, VENUE_ID)
    const second = await createDefaultAutoSendRules(sb, VENUE_ID)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })

  it('surfaces a Supabase error via ok:false instead of throwing', async () => {
    const { sb } = makeSupabaseMock({ data: null, error: { message: 'permission denied for table auto_send_rules', code: '42501' } })
    const result = await createDefaultAutoSendRules(sb, VENUE_ID)
    expect(result.ok).toBe(false)
    expect(result.created).toBe(0)
    expect(result.error).toMatch(/permission denied/)
  })
})
