import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SECTION_TYPES,
  DRESS_CODE_PRESET_KEYS,
  sectionHasContent,
  describeSection,
  summariseSections,
  type SectionType,
} from '../website-sections'

const publicPage = () =>
  readFileSync(resolve(process.cwd(), 'src/app/w/[slug]/page.tsx'), 'utf8')

describe('sectionHasContent mirrors what the public site renders', () => {
  it('our_story falls back to the website column', () => {
    expect(sectionHasContent('our_story', {})).toBe(false)
    expect(sectionHasContent('our_story', { text: 'we met in a queue' })).toBe(true)
    expect(sectionHasContent('our_story', {}, { our_story: 'from the column' })).toBe(true)
  })

  it('wedding_party and photo_gallery have no fallback', () => {
    expect(sectionHasContent('wedding_party', {})).toBe(false)
    expect(sectionHasContent('wedding_party', { members: [{ name: 'Rebecka', role: 'MOH' }] })).toBe(true)
    expect(sectionHasContent('photo_gallery', { photos: [] })).toBe(false)
    // The site filters falsy urls out before counting, so a list of blanks is empty.
    expect(sectionHasContent('photo_gallery', { photos: ['', null] })).toBe(false)
    expect(sectionHasContent('photo_gallery', { photos: ['https://example.test/a.jpg'] })).toBe(true)
  })

  it('registry and faq need both halves of each entry', () => {
    expect(sectionHasContent('registry', { links: [{ name: 'Crate', url: '' }] })).toBe(false)
    expect(sectionHasContent('registry', { links: [{ name: '', url: 'https://x.test' }] })).toBe(false)
    expect(sectionHasContent('registry', { links: [{ name: 'Crate', url: 'https://x.test' }] })).toBe(true)
    expect(sectionHasContent('faq', { items: [{ question: 'Parking?', answer: '' }] })).toBe(false)
    expect(sectionHasContent('faq', { items: [{ question: 'Parking?', answer: 'Yes' }] })).toBe(true)
  })

  it('things_to_do only needs a name', () => {
    expect(sectionHasContent('things_to_do', { items: [{ name: '' }] })).toBe(false)
    expect(sectionHasContent('things_to_do', { items: [{ name: 'The pub' }] })).toBe(true)
  })

  it('a dress code preset counts on its own, and "custom" does not', () => {
    expect(sectionHasContent('dress_code', { preset: 'cocktail' })).toBe(true)
    // `custom` means "use my own words", so it needs the words.
    expect(sectionHasContent('dress_code', { preset: 'custom' })).toBe(false)
    expect(sectionHasContent('dress_code', { preset: 'custom', custom_text: 'wear black' })).toBe(true)
    expect(sectionHasContent('dress_code', {}, { dress_code: 'from the column' })).toBe(true)
    // A preset the site does not know renders nothing, so it must not count.
    expect(sectionHasContent('dress_code', { preset: 'space_suits' })).toBe(false)
  })

  it('rsvp always renders, with or without anything filled in', () => {
    expect(sectionHasContent('rsvp', {})).toBe(true)
  })

  it('the two sections with rows we may not have loaded report unknown, not empty', () => {
    // Telling a couple their schedule is empty because we did not look is the
    // exact class of lie this module exists to stop.
    expect(sectionHasContent('the_day', {})).toBe(null)
    expect(sectionHasContent('nearby_stays', {})).toBe(null)
    // Given the counts, it can answer.
    expect(sectionHasContent('the_day', {}, { timelineCount: 0 })).toBe(false)
    expect(sectionHasContent('the_day', {}, { timelineCount: 3 })).toBe(true)
    expect(sectionHasContent('nearby_stays', {}, { accommodationsCount: 0 })).toBe(false)
    expect(sectionHasContent('nearby_stays', {}, { accommodationsCount: 2 })).toBe(true)
    // Its own content answers without needing them.
    expect(sectionHasContent('the_day', { ceremony_time: '4pm' })).toBe(true)
    expect(sectionHasContent('nearby_stays', { stays: [{ name: 'The inn' }] })).toBe(true)
  })
})

describe('describeSection', () => {
  const full = { text: 'we met in a queue' }

  it('off beats everything, however much content there is', () => {
    const d = describeSection('our_story', { enabled: false, published: true, data: full })
    expect(d.state).toBe('off')
    expect(d.visible).toBe(false)
  })

  it('empty beats ready, because publishing would not make it appear', () => {
    const d = describeSection('our_story', { enabled: true, published: false, data: {} })
    expect(d.state).toBe('empty')
    expect(d.detail).toMatch(/write your story/i)
  })

  it('on with content but unpublished is ready, not live', () => {
    const d = describeSection('our_story', { enabled: true, published: false, data: full })
    expect(d.state).toBe('ready')
    expect(d.visible).toBe(false)
  })

  it('on with content and published is live and visible', () => {
    const d = describeSection('our_story', { enabled: true, published: true, data: full })
    expect(d.state).toBe('live')
    expect(d.visible).toBe(true)
  })

  it('every section that can be empty says what to add', () => {
    for (const type of SECTION_TYPES) {
      const d = describeSection(type, { enabled: true, published: true, data: {} })
      if (d.state === 'empty') {
        expect(d.detail.trim(), `${type} must say what is missing`).not.toBe('')
      }
    }
  })
})

describe('summariseSections', () => {
  it('an unpublished site leads with that, not with a count', () => {
    const described = SECTION_TYPES.map(t =>
      describeSection(t, { enabled: true, published: false, data: { text: 'x', members: [{ name: 'a' }] } }),
    )
    expect(summariseSections(described, false)).toMatch(/^Nothing is live yet/)
  })

  it('a published site says how many a guest can see, and flags the empty ones', () => {
    const described = SECTION_TYPES.map(t =>
      describeSection(t, { enabled: true, published: true, data: {} }),
    )
    const line = summariseSections(described, true)
    expect(line).toMatch(/showing on your site/)
    expect(line).toMatch(/nothing in them yet/)
  })
})

// The point of the module: these are the site's rules, not a second guess at
// them. If a guard moves in page.tsx, this is what notices.
describe('pinned to src/app/w/[slug]/page.tsx', () => {
  it('each guard is still the one the section component renders on', () => {
    const src = publicPage()
    const guards = [
      "const text = (data.text as string) || website.our_story || ''",
      'if (members.length === 0) return null',
      'const photos = ((data.photos as string[]) || []).filter(Boolean)',
      'const hasBasic = ceremonyTime || receptionTime || details',
      'const filtered = links.filter(l => l.name && l.url)',
      'const filtered = items.filter(f => f.question && f.answer)',
      'const filtered = items.filter(t => t.name)',
      'const details = data.details as string',
      'const hasInline = inlineStays.some(s => s.name)',
      'const hasAccommodations = accommodations.length > 0',
    ]
    for (const guard of guards) {
      expect(src, `guard moved: \`${guard}\` — update src/lib/website-sections.ts to match`).toContain(guard)
    }
  })

  it('the dress code presets are the ones the site can render', () => {
    const src = publicPage()
    const block = src.slice(
      src.indexOf('const DRESS_CODE_PRESETS'),
      src.indexOf('const DRESS_CODE_PRESETS') + 900,
    )
    const onSite = [...block.matchAll(/^\s{2}([a-z_]+): \{ label:/gm)].map(m => m[1])
    expect(onSite.length).toBeGreaterThan(0)
    expect([...DRESS_CODE_PRESET_KEYS].sort()).toEqual([...onSite].sort())
  })

  it('every section type the builder offers is one the rules know', () => {
    const builder = readFileSync(
      resolve(process.cwd(), 'src/app/_couple-pages/website/page.tsx'),
      'utf8',
    )
    const block = builder.slice(
      builder.indexOf('const SECTION_META'),
      builder.indexOf('const DEFAULT_SECTION_ORDER'),
    )
    const inBuilder = [...block.matchAll(/^\s{2}([a-z_]+): \{ label:/gm)].map(m => m[1] as SectionType)
    expect(inBuilder.length).toBe(SECTION_TYPES.length)
    for (const type of inBuilder) {
      expect(SECTION_TYPES, `${type} is in the builder but not in SECTION_TYPES`).toContain(type)
    }
  })

  it('the blank-band guard is still wired into the renderer', () => {
    // The old `if (!content) return null` could never fire, because `content`
    // is always a JSX element. An enabled-but-empty section rendered a padded
    // <section> around nothing.
    const src = publicPage()
    expect(src).toContain('const hasContent = sectionHasContent(')
    expect(src).toContain('if (hasContent === false) return null')
  })
})
