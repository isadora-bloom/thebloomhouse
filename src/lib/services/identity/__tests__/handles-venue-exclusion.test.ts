/**
 * Wave 5 W36 (NOVEMBER-PLAN.md) — the venue's own handles are excluded
 * from a couple's signal, not stamped as if they were evidence about the
 * couple. Covers `stripVenueHandles`, `normalizeHandleInputs` (the
 * settings-save validator), and `getVenueSocialHandles` (the
 * venue_config-first, platform_configs-legacy-fallback reader with its
 * one-way copy).
 */
import { describe, it, expect } from 'vitest'
import {
  stripVenueHandles,
  normalizeHandleInputs,
  getVenueSocialHandles,
} from '../handles'
import { FakeSpineDb } from '@/lib/services/__tests__/fake-spine-db'

describe('stripVenueHandles', () => {
  it('removes a platform where the handle equals the venue\'s own', () => {
    const out = stripVenueHandles(
      { instagram: 'rixeymanor' },
      { instagram: 'rixeymanor' },
    )
    expect(out).toBeNull()
  })

  it('keeps a prospect\'s handle on a platform the venue does not share', () => {
    const out = stripVenueHandles(
      { instagram: 'rosie.hoyle' },
      { instagram: 'rixeymanor' },
    )
    expect(out).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('is platform-scoped: the same string on a different platform is not a match', () => {
    const out = stripVenueHandles(
      { instagram: 'rixeymanor' },
      { tiktok: 'rixeymanor' },
    )
    expect(out).toEqual({ instagram: 'rixeymanor' })
  })

  it('strips only the matching platform out of a multi-platform map', () => {
    const out = stripVenueHandles(
      { instagram: 'rixeymanor', tiktok: 'the.hoyles' },
      { instagram: 'rixeymanor' },
    )
    expect(out).toEqual({ tiktok: 'the.hoyles' })
  })

  it('passes handles through untouched when the venue has none on file', () => {
    expect(stripVenueHandles({ instagram: 'rosie.hoyle' }, null)).toEqual({
      instagram: 'rosie.hoyle',
    })
  })

  it('null in, null out', () => {
    expect(stripVenueHandles(null, { instagram: 'rixeymanor' })).toBeNull()
  })
})

describe('normalizeHandleInputs — the settings-save validator', () => {
  it('normalises a raw @handle and a profile URL the same way stripVenueHandles will compare', () => {
    const { handles, invalid } = normalizeHandleInputs({
      instagram: '@RixeyManor',
      facebook: 'https://www.facebook.com/rixeymanor/',
    })
    expect(handles).toEqual({ instagram: 'rixeymanor', facebook: 'rixeymanor' })
    expect(invalid).toEqual([])
  })

  it('rejects junk with the platform reported, not silently dropped', () => {
    const { handles, invalid } = normalizeHandleInputs({
      instagram: 'not a handle at all!!',
    })
    expect(handles).toEqual({})
    expect(invalid).toEqual(['instagram'])
  })

  it('a blank field is not an error', () => {
    const { handles, invalid } = normalizeHandleInputs({ instagram: '   ' })
    expect(handles).toEqual({})
    expect(invalid).toEqual([])
  })

  it('one bad platform does not block another good one', () => {
    const { handles, invalid } = normalizeHandleInputs({
      instagram: 'rixeymanor',
      tiktok: 'not valid !!',
    })
    expect(handles).toEqual({ instagram: 'rixeymanor' })
    expect(invalid).toEqual(['tiktok'])
  })
})

describe('getVenueSocialHandles', () => {
  it('reads venue_config.social_handles when it already has the platform, over a stale legacy value', async () => {
    const db = new FakeSpineDb()
    db.seed('venue_config', [
      { venue_id: 'venue-1', social_handles: { instagram: 'rixeymanor' } },
    ])
    db.seed('platform_configs', [
      { venue_id: 'venue-1', platform: 'instagram', venue_handle: 'stale-legacy-value' },
    ])

    const handles = await getVenueSocialHandles(db.client(), 'venue-1')
    expect(handles).toEqual({ instagram: 'rixeymanor' })
    // Already agreed — no copy needed, so the update call never fires.
    expect(db.calls).not.toContain('venue_config.update')
  })

  it('scopes strictly to the requested venue — a different venue with no rows gets null', async () => {
    const db = new FakeSpineDb()
    db.seed('venue_config', [
      { venue_id: 'venue-1', social_handles: { instagram: 'rixeymanor' } },
    ])

    const handles = await getVenueSocialHandles(db.client(), 'venue-1-other')
    expect(handles).toBeNull()
  })

  it('falls back to platform_configs.venue_handle and copies it into venue_config once', async () => {
    const db = new FakeSpineDb()
    db.seed('venue_config', [{ venue_id: 'venue-2', social_handles: {} }])
    db.seed('platform_configs', [
      { venue_id: 'venue-2', platform: 'instagram', venue_handle: '@RixeyManor' },
    ])

    const handles = await getVenueSocialHandles(db.client(), 'venue-2')
    expect(handles).toEqual({ instagram: 'rixeymanor' })
    // The one-way copy landed on venue_config.
    expect(db.table('venue_config')[0]!.social_handles).toEqual({ instagram: 'rixeymanor' })
  })

  it('a venue_config value wins over a disagreeing legacy value', async () => {
    const db = new FakeSpineDb()
    db.seed('venue_config', [
      { venue_id: 'venue-3', social_handles: { instagram: 'the_real_handle' } },
    ])
    db.seed('platform_configs', [
      { venue_id: 'venue-3', platform: 'instagram', venue_handle: 'an_old_typo' },
    ])

    const handles = await getVenueSocialHandles(db.client(), 'venue-3')
    expect(handles).toEqual({ instagram: 'the_real_handle' })
  })

  it('returns null when neither source has anything for this venue', async () => {
    const db = new FakeSpineDb()
    db.seed('venue_config', [{ venue_id: 'venue-4', social_handles: {} }])

    const handles = await getVenueSocialHandles(db.client(), 'venue-4')
    expect(handles).toBeNull()
  })
})
