/**
 * What is actually showing on a couple's wedding website, and why not.
 *
 * Three separate things decide whether a guest sees a section, and each surface
 * knew about a different subset:
 *
 *   1. is the site published
 *   2. is the section switched on
 *   3. is there anything for it to render
 *
 * The builder only ever knew (2). Its header counted the switches and called
 * them "active", and its preview filled the empty ones with encouragement —
 * "Your love story will appear here…", "Registry links will appear here" —
 * for sections the live site drops entirely. Ten of the eleven section
 * components on `/w/[slug]` return null when they have no content, so a couple
 * could switch a section on, see it in the preview with a heading and a
 * placeholder, publish, and find nothing there.
 *
 * The same disagreement cost a Rixey couple three days in September: the panel
 * said "38 members ready" in green while the section itself was switched off,
 * and separately her photo gallery counted one photo that the site would never
 * render. The rules are worth keeping in one place.
 *
 * KEEP IN STEP WITH src/app/w/[slug]/page.tsx. Each `hasContent` below is the
 * guard that section component renders on, and
 * `src/lib/__tests__/website-sections.test.ts` pins the pairs.
 */

export const SECTION_TYPES = [
  'our_story',
  'wedding_party',
  'dress_code',
  'the_day',
  'transportation',
  'nearby_stays',
  'registry',
  'faq',
  'photo_gallery',
  'rsvp',
  'things_to_do',
] as const

export type SectionType = (typeof SECTION_TYPES)[number]

export interface RegistryLinkish { name?: string | null; url?: string | null }
export interface FaqItemish { question?: string | null; answer?: string | null }
export interface NamedItem { name?: string | null }

/**
 * Everything outside the section's own `data` that a guard can fall back on.
 *
 * `the_day` and `nearby_stays` fall back to rows the builder does not load with
 * its settings, so those two counts are optional. Unknown is not the same as
 * zero: a section whose only possible content is a count we have not been given
 * is reported as unknown rather than empty, because telling a couple their
 * schedule is empty when we simply did not look is the bug this file exists to
 * stop.
 */
export interface SectionContext {
  our_story?: string | null
  dress_code?: string | null
  registry_links?: RegistryLinkish[] | null
  faq?: FaqItemish[] | null
  things_to_do?: NamedItem[] | null
  /** Rows in `timeline` for this wedding. Undefined when not loaded. */
  timelineCount?: number
  /** Rows in `accommodations` for this venue. Undefined when not loaded. */
  accommodationsCount?: number
}

type Data = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/**
 * Presets the dress code section can render without any text of its own.
 *
 * These are the keys of DRESS_CODE_PRESETS in src/app/w/[slug]/page.tsx. A key
 * missing here makes the panel call a section empty that the site will happily
 * render, so the test pins the two lists together. Note `custom` is not one of
 * them: the site treats it as "use my own words" and falls through to the text.
 */
export const DRESS_CODE_PRESET_KEYS = [
  'black_tie',
  'black_tie_optional',
  'cocktail',
  'garden',
  'smart_casual',
  'casual',
] as const

/**
 * Does this section have something to render?
 *
 * `null` means we cannot tell from what we were given, which only happens for
 * the two sections whose fallback rows the caller did not load.
 */
export function sectionHasContent(
  type: SectionType,
  data: Data | null | undefined,
  ctx: SectionContext = {},
): boolean | null {
  const d: Data = data ?? {}

  switch (type) {
    // `(data.text as string) || website.our_story || ''`
    case 'our_story':
      return Boolean(str(d.text) || str(ctx.our_story))

    // `(data.members as Array<…>) || []` — no fallback
    case 'wedding_party':
      return arr(d.members).length > 0

    // `((data.photos as string[]) || []).filter(Boolean)`
    case 'photo_gallery':
      return arr<string>(d.photos).filter(Boolean).length > 0

    // `hasTimeline || ceremony_time || reception_time || details`
    case 'the_day': {
      const hasBasic = Boolean(str(d.ceremony_time) || str(d.reception_time) || str(d.details))
      if (hasBasic) return true
      if (ctx.timelineCount === undefined) return null
      return ctx.timelineCount > 0
    }

    // `preset && preset !== 'custom' && PRESETS[preset]` ? preset text
    //   : `(data.custom_text as string) || website.dress_code || ''`
    case 'dress_code': {
      const preset = str(d.preset)
      const usesPreset =
        preset !== '' && preset !== 'custom' && (DRESS_CODE_PRESET_KEYS as readonly string[]).includes(preset)
      if (usesPreset) return true
      return Boolean(str(d.custom_text) || str(ctx.dress_code))
    }

    // `(data.details as string)` — no fallback
    case 'transportation':
      return Boolean(str(d.details))

    // `inlineStays.some(s => s.name) || accommodations.length > 0`
    case 'nearby_stays': {
      const hasInline = arr<NamedItem>(d.stays).some((s) => Boolean(str(s?.name)))
      if (hasInline) return true
      if (ctx.accommodationsCount === undefined) return null
      return ctx.accommodationsCount > 0
    }

    // `(links).filter(l => l.name && l.url)`
    case 'registry': {
      const links = arr<RegistryLinkish>(d.links).length
        ? arr<RegistryLinkish>(d.links)
        : arr<RegistryLinkish>(ctx.registry_links)
      return links.filter((l) => Boolean(str(l?.name)) && Boolean(str(l?.url))).length > 0
    }

    // `(items).filter(f => f.question && f.answer)`
    case 'faq': {
      const items = arr<FaqItemish>(d.items).length ? arr<FaqItemish>(d.items) : arr<FaqItemish>(ctx.faq)
      return items.filter((f) => Boolean(str(f?.question)) && Boolean(str(f?.answer))).length > 0
    }

    // `(items).filter(t => t.name)`
    case 'things_to_do': {
      const items = arr<NamedItem>(d.items).length ? arr<NamedItem>(d.items) : arr<NamedItem>(ctx.things_to_do)
      return items.filter((t) => Boolean(str(t?.name))).length > 0
    }

    // The RSVP form renders whether or not anything has been filled in.
    case 'rsvp':
      return true

    default:
      return false
  }
}

export type SectionState = 'live' | 'ready' | 'empty' | 'unknown' | 'off'

const HEADLINES: Record<SectionState, string> = {
  live: 'Showing on your website',
  ready: 'Ready, not published yet',
  empty: 'On, but nothing to show yet',
  unknown: 'On',
  off: 'Hidden from guests',
}

/**
 * What a couple needs to add before a section will appear, in their words.
 * Only used when the section is on and empty, so every one of these is
 * something they can act on.
 */
const WHAT_IS_MISSING: Record<SectionType, string> = {
  our_story: 'Write your story below and it appears here.',
  wedding_party: 'Add the people standing beside you below.',
  dress_code: 'Choose a dress code below, or write your own.',
  the_day: 'Add a ceremony or reception time below, or build your timeline.',
  transportation: 'Add shuttle or parking details below.',
  nearby_stays: 'Add a place to stay below. Rixey’s own list also fills this in.',
  registry: 'Add a registry link below. A link needs both a name and a URL.',
  faq: 'Add a question below. Each one needs an answer too.',
  photo_gallery: 'Add photos below.',
  rsvp: '',
  things_to_do: 'Add somewhere to go below.',
}

export interface SectionDescription {
  type: SectionType
  state: SectionState
  headline: string
  detail: string
  /** True when a guest would see this section right now. */
  visible: boolean
}

/**
 * One section, described from the couple's point of view.
 *
 * `empty` beats `ready` on purpose: if there is nothing to show, telling them
 * to publish would be a lie.
 */
export function describeSection(
  type: SectionType,
  opts: { enabled: boolean; published: boolean; data?: Data | null; ctx?: SectionContext },
): SectionDescription {
  const { enabled, published } = opts
  if (!enabled) {
    return {
      type,
      state: 'off',
      headline: HEADLINES.off,
      detail: 'Guests will not see this, even once your site is live.',
      visible: false,
    }
  }

  const has = sectionHasContent(type, opts.data, opts.ctx)

  if (has === false) {
    return { type, state: 'empty', headline: HEADLINES.empty, detail: WHAT_IS_MISSING[type], visible: false }
  }
  if (has === null) {
    return {
      type,
      state: 'unknown',
      headline: HEADLINES.unknown,
      detail: 'Shows when there is something in it.',
      visible: published,
    }
  }
  return published
    ? { type, state: 'live', headline: HEADLINES.live, detail: 'Guests can see this now.', visible: true }
    : {
        type,
        state: 'ready',
        headline: HEADLINES.ready,
        detail: 'Ready to go. Publish your site to make it live.',
        visible: false,
      }
}

/**
 * The line for the top of the panel, so the first thing a couple reads is the
 * answer rather than eleven switches to add up themselves.
 */
export function summariseSections(described: SectionDescription[], published: boolean): string {
  const live = described.filter((d) => d.state === 'live' || (d.state === 'unknown' && published)).length
  const ready = described.filter((d) => d.state === 'ready' || (d.state === 'unknown' && !published)).length
  const empty = described.filter((d) => d.state === 'empty').length

  if (!published) {
    return ready > 0
      ? `Nothing is live yet. ${ready} ${ready === 1 ? 'section is' : 'sections are'} ready and waiting for you to publish.`
      : 'Nothing is live yet, and no section has anything in it so far.'
  }
  const head = `${live} ${live === 1 ? 'section is' : 'sections are'} showing on your site`
  return empty > 0
    ? `${head}. ${empty} ${empty === 1 ? 'is' : 'are'} switched on with nothing in ${empty === 1 ? 'it' : 'them'} yet.`
    : `${head}.`
}
