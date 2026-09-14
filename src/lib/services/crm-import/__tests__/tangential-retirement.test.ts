/**
 * W68 (wave 9) — the tangential pool is retired at the writers.
 *
 * Migration 400 said `tangential_signals` took no new rows. Four adapters
 * were still filling it. These tests cover the mapping each of those
 * adapters now does instead: CSV row in, `NormalizedSignal` out, ready for
 * `linkSignal`. No database and no network — the whole contract of the
 * conversion lives in these pure functions, which is why they were pulled
 * out and exported.
 *
 * The invariant worth guarding above all others: a partial name must NOT
 * land in `primary_name`. `hasSufficientIdentity` mints a couple for any
 * two-token primary_name, so "Jayden P." off a storefront views export, or
 * a display name off a followers list, would mint couples by the hundred.
 * Partial identity rides as `identity_hint`, which the matcher still reads
 * and a fragment row still stores.
 */

import { describe, expect, it } from 'vitest'
import { anonymousVisitorToSignal, orphanPageviewToSignal } from '../site-visitors'
import { storefrontSignalToSignal } from '../storefront-activity'
import { universalRowToSignal } from '@/lib/services/ingestion/platform-signals'
import { hasSufficientIdentity } from '@/lib/services/identity/mint-couple'
import type { UniversalSignalRow } from '@/lib/services/platform-detectors/types'

// ---------------------------------------------------------------------------
// Website pixel
// ---------------------------------------------------------------------------

function visitor(overrides: Record<string, unknown> = {}) {
  return {
    visitor_id: 'vis_abc123',
    first_seen_at: '2026-06-01T10:00:00.000Z',
    last_seen_at: '2026-06-03T10:00:00.000Z',
    visit_count: 3,
    pageview_count: 11,
    first_source: 'google',
    first_medium: 'organic',
    first_campaign: null,
    first_content: null,
    first_term: null,
    first_referrer: 'https://google.com/',
    first_landing_page: '/weddings',
    last_source: null,
    last_medium: null,
    last_campaign: null,
    last_referrer: null,
    last_landing_page: null,
    first_name: 'Maddie',
    partner_name: null,
    email: null,
    phone: null,
    role: null,
    identified_at: null,
    user_agent: null,
    ip_country: 'US',
    raw_row: {},
    ...overrides,
  } as Parameters<typeof anonymousVisitorToSignal>[0]
}

describe('site-visitors — anonymous visitor to signal', () => {
  it('carries the pixel first name as a hint, never as primary_name', () => {
    const s = anonymousVisitorToSignal(visitor())
    expect(s.primary_name).toBeNull()
    expect(s.identity_hint).toBe('Maddie')
    expect(s.channel).toBe('web')
    expect(s.action_type).toBe('web_visit')
    expect(s.occurred_at).toBe('2026-06-01T10:00:00.000Z')
  })

  it('stays below the mint gate, so it lands as a fragment', () => {
    expect(hasSufficientIdentity(anonymousVisitorToSignal(visitor()))).toBe(false)
  })

  it('derives external_id from visitor_id so a re-upload is a no-op', () => {
    const a = anonymousVisitorToSignal(visitor())
    const b = anonymousVisitorToSignal(visitor({ pageview_count: 42, visit_count: 9 }))
    expect(a.external_id).toBe(b.external_id)
    // The slug is punctuation-free, so the underscore becomes a hyphen.
    expect(a.external_id).toBe('web:visitor:vis-abc123')
  })

  it('separates two different visitors', () => {
    const a = anonymousVisitorToSignal(visitor())
    const b = anonymousVisitorToSignal(visitor({ visitor_id: 'vis_zzz999' }))
    expect(a.external_id).not.toBe(b.external_id)
  })

  it('keeps the first-touch UTM on the payload for the attribution crons', () => {
    const s = anonymousVisitorToSignal(visitor())
    expect(s.raw_payload).toMatchObject({
      utm_source: 'google',
      utm_medium: 'organic',
      visitor_id: 'vis_abc123',
    })
  })
})

describe('site-visitors — orphan pageview to signal', () => {
  it('is aggregate_only, so the heat score ignores it', () => {
    const s = orphanPageviewToSignal({
      visitor_id: 'vis_orphan',
      session_id: 'sess_1',
      path: '/pricing',
      query: null,
      referrer: null,
      ts: '2026-06-02T12:00:00.000Z',
    })
    expect(s.signal_tier).toBe('aggregate_only')
    expect(s.primary_name).toBeNull()
    expect(hasSufficientIdentity(s)).toBe(false)
  })

  it('gives two pageviews in one session distinct ids', () => {
    const base = {
      visitor_id: 'vis_orphan',
      session_id: 'sess_1',
      query: null,
      referrer: null,
      ts: '2026-06-02T12:00:00.000Z',
    }
    const a = orphanPageviewToSignal({ ...base, path: '/pricing' })
    const b = orphanPageviewToSignal({ ...base, path: '/gallery' })
    expect(a.external_id).not.toBe(b.external_id)
  })
})

// ---------------------------------------------------------------------------
// Storefront activity
// ---------------------------------------------------------------------------

function storefrontRow(overrides: Record<string, unknown> = {}) {
  return {
    action_raw: 'Storefront View',
    action_class: 'view',
    signal_class: 'touchpoint' as const,
    funnel_stage: 'view',
    visitor_first_name: 'Jayden',
    visitor_last_initial: 'P',
    visitor_name_raw: 'Jayden P.',
    city: 'Arlington',
    state: 'VA',
    signal_date: '2026-05-04T00:00:00.000Z',
    raw_row: {},
    ...overrides,
  } as Parameters<typeof storefrontSignalToSignal>[0]
}

describe('storefront-activity — funnel row to signal', () => {
  it('refuses to let "Jayden P." mint a couple', () => {
    const s = storefrontSignalToSignal(storefrontRow(), 'the_knot')
    expect(s.primary_name).toBeNull()
    expect(s.identity_hint).toBe('Jayden P.')
    expect(hasSufficientIdentity(s)).toBe(false)
  })

  it('rides on the marketplace channel, not a storefront-only one', () => {
    expect(storefrontSignalToSignal(storefrontRow(), 'the_knot').channel).toBe('knot')
    expect(storefrontSignalToSignal(storefrontRow(), 'wedding_wire').channel).toBe('weddingwire')
  })

  it('ranks a message above a view', () => {
    const view = storefrontSignalToSignal(storefrontRow(), 'the_knot')
    const message = storefrontSignalToSignal(
      storefrontRow({ funnel_stage: 'message', action_class: 'message', action_raw: 'Message' }),
      'the_knot',
    )
    expect(view.signal_tier).toBe('low')
    expect(message.signal_tier).toBe('medium')
    expect(message.action_type).toBe('storefront_message')
  })

  it('collapses a re-uploaded rolling window onto the same external_id', () => {
    const a = storefrontSignalToSignal(storefrontRow(), 'the_knot')
    const b = storefrontSignalToSignal(storefrontRow({ raw_row: { extra: 'column' } }), 'the_knot')
    expect(a.external_id).toBe(b.external_id)
  })

  it('separates the same visitor viewing on two different days', () => {
    const a = storefrontSignalToSignal(storefrontRow(), 'the_knot')
    const b = storefrontSignalToSignal(
      storefrontRow({ signal_date: '2026-05-11T00:00:00.000Z' }),
      'the_knot',
    )
    expect(a.external_id).not.toBe(b.external_id)
  })
})

// ---------------------------------------------------------------------------
// Platform signals (every platform CSV)
// ---------------------------------------------------------------------------

function universalRow(overrides: Partial<UniversalSignalRow> = {}): UniversalSignalRow {
  return {
    name_raw: 'Kara P.',
    first_name: 'Kara',
    last_initial: 'P',
    last_name: null,
    username: null,
    email: null,
    city: 'Richmond',
    state: 'VA',
    country: 'US',
    action_class: 'save',
    signal_date: '2026-04-09T00:00:00.000Z',
    source_context: 'Storefront Save on the_knot',
    raw_row: {},
    ...overrides,
  }
}

describe('platform-signals — universal row to signal', () => {
  it('keeps a first-name-plus-initial row below the mint gate', () => {
    const s = universalRowToSignal(universalRow(), 'the_knot', null)
    expect(s.primary_name).toBeNull()
    expect(s.identity_hint).toBe('Kara P.')
    expect(hasSufficientIdentity(s)).toBe(false)
  })

  it('promotes a row that carries a real surname to primary_name', () => {
    const s = universalRowToSignal(
      universalRow({ name_raw: 'Kara Prentice', last_name: 'Prentice' }),
      'the_knot',
      null,
    )
    expect(s.primary_name).toBe('Kara Prentice')
    expect(hasSufficientIdentity(s)).toBe(true)
  })

  it('normalises an Instagram username into a platform handle', () => {
    const s = universalRowToSignal(
      universalRow({ username: '@Kara_P', action_class: 'follow', name_raw: null }),
      'instagram',
      null,
    )
    expect(s.handles).toEqual({ instagram: 'kara_p' })
    expect(s.channel).toBe('instagram')
    expect(s.action_type).toBe('follow')
    expect(s.identity_hint).toBe('@kara_p')
    // A handle is not a reachable address (HANDLE-IDENTITY-SPEC.md §3),
    // so a follower stays a fragment until a real identity shares it.
    expect(hasSufficientIdentity(s)).toBe(false)
  })

  it('does not invent a handle on a platform with no handle namespace', () => {
    const s = universalRowToSignal(
      universalRow({ username: 'someone', action_class: 'review' }),
      'google_business',
      null,
    )
    expect(s.handles).toBeNull()
    expect(s.channel).toBe('review')
    expect(s.action_type).toBe('review_left')
  })

  it('keeps the precise action_class instead of collapsing it to analytics_entry', () => {
    expect(universalRowToSignal(universalRow({ action_class: 'view' }), 'the_knot', null).action_type)
      .toBe('view')
    expect(universalRowToSignal(universalRow({ action_class: 'click' }), 'the_knot', null).action_type)
      .toBe('click')
  })

  it('derives a stable external_id, so a weekly re-upload is a no-op', () => {
    const a = universalRowToSignal(universalRow(), 'the_knot', null)
    const b = universalRowToSignal(universalRow({ raw_row: { seen: 'again' } }), 'the_knot', 'entry-2')
    expect(a.external_id).toBe(b.external_id)
  })

  it('lets a row carrying an email mint, because an email is reachable', () => {
    const s = universalRowToSignal(
      universalRow({ email: 'kara@example.com' }),
      'google_business',
      null,
    )
    expect(s.primary_email).toBe('kara@example.com')
    expect(hasSufficientIdentity(s)).toBe(true)
  })
})
