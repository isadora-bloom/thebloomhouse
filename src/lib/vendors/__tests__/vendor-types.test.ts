/**
 * The vendor vocabulary, and why it is a shared module now.
 *
 * On 2026-09-17 the live `vendor_recommendations` table held 28 rows
 * across 4 venues, written by two surfaces that disagreed: the couple
 * page keyed its labels on lowercase snake_case, the staff editor wrote
 * Title Case. The table had `photography`(4) next to `photographer`(1),
 * `florals`(3) next to `florist`(2), `catering`(2) next to `caterer`(2),
 * plus `cake`, `music`, `videography` and `bartender`. Thirteen of the 28
 * rendered to couples as "Other", in an "Other" pill beside the
 * correctly-labelled one, and the category filter filtered on that.
 *
 * The first block below is those exact live values. It is the regression
 * test for the bug, and it fails loudly if the synonym table drifts from
 * migration 417.
 */

import { describe, it, expect } from 'vitest'
import {
  VENDOR_ATTRIBUTES,
  VENDOR_TYPES,
  VENDOR_TYPE_KEYS,
  hasLiveOffer,
  normaliseVendorType,
  vendorTypeColor,
  vendorTypeLabel,
} from '../vendor-types'

describe('normaliseVendorType — the values actually in the table', () => {
  const live: Array<[string, string]> = [
    ['dj', 'dj'],
    ['photography', 'photographer'],
    ['transportation', 'transportation'],
    ['florals', 'florist'],
    ['caterer', 'caterer'],
    ['florist', 'florist'],
    ['catering', 'caterer'],
    ['photographer', 'photographer'],
    ['bartender', 'bartender'],
    ['officiant', 'officiant'],
    ['cake', 'baker'],
    ['hair_makeup', 'hair_makeup'],
    ['music', 'music'],
    ['videography', 'videographer'],
  ]

  it.each(live)('folds %s onto %s', (raw, expected) => {
    expect(normaliseVendorType(raw)).toBe(expected)
  })

  it('labels every live value as itself, never as Other', () => {
    for (const [raw] of live) {
      expect(vendorTypeLabel(raw)).not.toBe('Other')
    }
  })

  it('leaves photography and photographer in one category', () => {
    expect(normaliseVendorType('photography')).toBe(normaliseVendorType('photographer'))
    expect(normaliseVendorType('florals')).toBe(normaliseVendorType('florist'))
    expect(normaliseVendorType('catering')).toBe(normaliseVendorType('caterer'))
  })
})

describe('normaliseVendorType', () => {
  it('reads the Title Case the staff editor used to write', () => {
    expect(normaliseVendorType('Photographer')).toBe('photographer')
    expect(normaliseVendorType('Hair & Makeup')).toBe('hair_makeup')
    expect(normaliseVendorType('DJ')).toBe('dj')
    expect(normaliseVendorType('Stationer')).toBe('stationery')
  })

  it('copes with spacing, hyphens, slashes and stray case', () => {
    expect(normaliseVendorType('  Hair-Makeup ')).toBe('hair_makeup')
    expect(normaliseVendorType('food/truck')).toBe('caterer')
    expect(normaliseVendorType('HAIR AND MAKEUP')).toBe('hair_makeup')
  })

  it('treats an empty or missing value as other', () => {
    expect(normaliseVendorType('')).toBe('other')
    expect(normaliseVendorType('   ')).toBe('other')
    expect(normaliseVendorType(null)).toBe('other')
    expect(normaliseVendorType(undefined)).toBe('other')
  })

  it('strips a plural off a canonical key', () => {
    expect(normaliseVendorType('officiants')).toBe('officiant')
    expect(normaliseVendorType('planners')).toBe('planner')
  })

  it('keeps music apart from dj and band, because nobody said which', () => {
    expect(normaliseVendorType('music')).toBe('music')
    expect(normaliseVendorType('live music')).toBe('music')
    expect(normaliseVendorType('dj')).not.toBe('music')
    expect(normaliseVendorType('band')).not.toBe('music')
  })

  it('hands back an unrecognised value as its own slug, not other', () => {
    expect(normaliseVendorType('llama wrangler')).toBe('llama_wrangler')
    expect(normaliseVendorType('Fireworks')).toBe('fireworks')
  })

  it('is stable: normalising twice changes nothing', () => {
    for (const raw of ['photography', 'Hair & Makeup', 'llama wrangler', '', 'cake']) {
      const once = normaliseVendorType(raw)
      expect(normaliseVendorType(once)).toBe(once)
    }
  })

  it('leaves every canonical key untouched', () => {
    for (const key of VENDOR_TYPE_KEYS) {
      expect(normaliseVendorType(key)).toBe(key)
    }
  })
})

describe('vendorTypeLabel', () => {
  it('uses the curated label for a canonical key', () => {
    expect(vendorTypeLabel('hair_makeup')).toBe('Hair & Makeup')
    expect(vendorTypeLabel('baker')).toBe('Cake / Bakery')
  })

  it('humanises an unknown value rather than calling it Other', () => {
    expect(vendorTypeLabel('llama wrangler')).toBe('Llama Wrangler')
    expect(vendorTypeLabel('ice_sculptor')).toBe('Ice Sculptor')
  })

  it('still says Other for nothing at all', () => {
    expect(vendorTypeLabel(null)).toBe('Other')
    expect(vendorTypeLabel('')).toBe('Other')
  })
})

describe('vendorTypeColor', () => {
  it('gives a canonical key its own colour', () => {
    expect(vendorTypeColor('florist')).toBe(VENDOR_TYPES.florist.color)
    expect(vendorTypeColor('florals')).toBe(VENDOR_TYPES.florist.color)
  })

  it('falls back to the neutral grey for an unknown category', () => {
    expect(vendorTypeColor('llama wrangler')).toBe(VENDOR_TYPES.other.color)
  })
})

describe('hasLiveOffer', () => {
  const day = 24 * 60 * 60 * 1000

  it('is false with no offer text, whatever the expiry says', () => {
    expect(hasLiveOffer({})).toBe(false)
    expect(hasLiveOffer({ special_offer: null })).toBe(false)
    expect(hasLiveOffer({ special_offer: '', offer_expires_at: '2099-01-01' })).toBe(false)
  })

  it('is true for an offer with no expiry', () => {
    expect(hasLiveOffer({ special_offer: '10% off midweek' })).toBe(true)
  })

  it('is true up to and including the expiry date, false after', () => {
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const today = new Date()
    expect(
      hasLiveOffer({ special_offer: 'x', offer_expires_at: iso(today) })
    ).toBe(true)
    expect(
      hasLiveOffer({ special_offer: 'x', offer_expires_at: iso(new Date(Date.now() + day)) })
    ).toBe(true)
    expect(
      hasLiveOffer({ special_offer: 'x', offer_expires_at: iso(new Date(Date.now() - day)) })
    ).toBe(false)
  })

  it('treats an unparseable expiry as still running rather than hiding the offer', () => {
    expect(hasLiveOffer({ special_offer: 'x', offer_expires_at: 'not a date' })).toBe(true)
  })
})

describe('VENDOR_ATTRIBUTES', () => {
  it('carries the four Rixey toggles', () => {
    expect(VENDOR_ATTRIBUTES.map((a) => a.key)).toEqual([
      'special_offer',
      'is_local',
      'is_budget_friendly',
      'has_multiple_events',
    ])
  })

  it('only the offer is badgeless, because the card gives it a callout', () => {
    const badgeless = VENDOR_ATTRIBUTES.filter((a) => a.badgeLabel === null)
    expect(badgeless.map((a) => a.key)).toEqual(['special_offer'])
  })

  it('does not name a venue in any couple-facing wording', () => {
    for (const a of VENDOR_ATTRIBUTES) {
      expect(a.filterLabel.toLowerCase()).not.toContain('rixey')
      expect((a.badgeLabel ?? '').toLowerCase()).not.toContain('rixey')
    }
  })

  it('reads a false flag as not having the attribute', () => {
    const local = VENDOR_ATTRIBUTES.find((a) => a.key === 'is_local')!
    expect(local.test({ is_local: true })).toBe(true)
    expect(local.test({ is_local: false })).toBe(false)
    expect(local.test({ is_local: null })).toBe(false)
    expect(local.test({})).toBe(false)
  })
})
