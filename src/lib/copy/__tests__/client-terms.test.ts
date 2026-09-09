import { describe, it, expect } from 'vitest'
import {
  CLIENT_TERMS,
  agoPhrase,
  channelLabel,
  clientTerm,
  countPhrase,
  dayLabel,
  daysBetween,
  honestNumber,
  lifecycleCount,
  lifecycleLabel,
  notEnoughReason,
  pluralise,
  sampleNote,
  timeLabel,
  dayTimeLabel,
  whenLabel,
} from '../client-terms'

const NOW = Date.parse('2026-09-08T09:00:00.000Z')

describe('clientTerm', () => {
  it('translates the internal words a coordinator must never see', () => {
    expect(clientTerm('touchpoint')).toBe('message')
    expect(clientTerm('heat')).toBe('interest')
    expect(clientTerm('decay')).toBe('going quiet')
    expect(clientTerm('cohort')).toBe('group of couples')
    expect(clientTerm('cascade')).toBe('matching')
  })

  it('treats underscores, hyphens and spaces as the same separator', () => {
    expect(clientTerm('first_touch')).toBe('where they found you')
    expect(clientTerm('first-touch')).toBe('where they found you')
    expect(clientTerm('First Touch')).toBe('where they found you')
    expect(clientTerm('heat_score')).toBe('interest')
  })

  it('passes an unmapped term through rather than blanking it', () => {
    expect(clientTerm('sprocket')).toBe('sprocket')
    expect(clientTerm('')).toBe('')
    expect(clientTerm(null)).toBe('')
    expect(clientTerm(undefined)).toBe('')
  })

  it('has no mapping whose replacement is itself internal vocabulary', () => {
    const banned = ['touchpoint', 'lifecycle', 'cascade', 'spine', 'decay', 'cohort', 'enoughdata']
    for (const [key, value] of Object.entries(CLIENT_TERMS)) {
      for (const word of banned) {
        expect(
          value.toLowerCase().includes(word),
          `mapping for "${key}" still contains "${word}": ${value}`,
        ).toBe(false)
      }
    }
  })
})

describe('lifecycle wording', () => {
  it('maps every lifecycle_state value to plain words', () => {
    expect(lifecycleLabel('resolved')).toBe('in conversation')
    expect(lifecycleLabel('ghost')).toBe('gone quiet')
    expect(lifecycleLabel('booked')).toBe('booked')
    expect(lifecycleLabel('channel_scoped')).toBe('new enquiry')
    expect(lifecycleLabel('completed')).toBe('wedding done')
    expect(lifecycleLabel('agent')).toBe('not a couple')
  })

  it('never leaks a raw enum, even for an unknown value', () => {
    expect(lifecycleLabel(null)).toBe('not placed yet')
    expect(lifecycleLabel(undefined)).toBe('not placed yet')
  })

  it('builds count phrases for the briefing sentence', () => {
    expect(lifecycleCount('resolved', 12)).toBe('12 in conversation')
    expect(lifecycleCount('channel_scoped', 8)).toBe('8 new enquiries')
    expect(lifecycleCount('ghost', 1)).toBe('1 gone quiet')
  })
})

describe('honestNumber', () => {
  it('shows the number and its sample size when there is enough behind it', () => {
    const r = honestNumber(
      { value: 0.42, n: 312, enoughData: true },
      { format: (v) => `${Math.round(v * 100)}%` },
    )
    expect(r).toEqual({ text: '42%', isNumber: true, sample: 'based on 312 couples' })
  })

  it('shows the reason instead of the number when there is not', () => {
    expect(honestNumber({ value: null, n: 0, enoughData: false, reason: 'no_data' })).toEqual({
      text: 'nothing recorded yet',
      isNumber: false,
      sample: '',
    })
    expect(honestNumber({ value: null, n: 4, enoughData: false, reason: 'zero_denominator' })).toEqual(
      { text: 'nothing to measure against yet', isNumber: false, sample: 'based on 4 couples' },
    )
    expect(honestNumber({ value: 0.9, n: 2, enoughData: false, reason: 'insufficient_sample' })).toEqual(
      { text: 'not enough to say yet', isNumber: false, sample: 'based on 2 couples' },
    )
  })

  it('never lets a real 0 be mistaken for missing data', () => {
    const r = honestNumber({ value: 0, n: 40, enoughData: true })
    expect(r.isNumber).toBe(true)
    expect(r.text).toBe('0')
  })

  it('falls back to the house phrase for an unknown reason', () => {
    expect(notEnoughReason('something_new')).toBe('not enough to say yet')
    expect(notEnoughReason(undefined)).toBe('not enough to say yet')
  })
})

describe('counts', () => {
  it('pluralises the nouns this app uses', () => {
    expect(pluralise(1, 'couple')).toBe('couple')
    expect(pluralise(2, 'couple')).toBe('couples')
    expect(pluralise(2, 'enquiry')).toBe('enquiries')
    expect(pluralise(2, 'match')).toBe('matches')
    expect(pluralise(3, 'person', 'people')).toBe('people')
  })

  it('drops the sample note at n = 0 rather than saying "based on 0"', () => {
    expect(sampleNote(0)).toBe('')
    expect(sampleNote(1)).toBe('based on 1 couple')
    expect(sampleNote(7, 'message')).toBe('based on 7 messages')
  })

  it('builds count phrases', () => {
    expect(countPhrase(1, 'day')).toBe('1 day')
    expect(countPhrase(94, 'day')).toBe('94 days')
  })
})

describe('plain-English time', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-09-05T09:00:00.000Z', NOW)).toBe(3)
    expect(daysBetween(null, NOW)).toBe(null)
    expect(daysBetween('not a date', NOW)).toBe(null)
  })

  it('says how long ago the way a person says it', () => {
    expect(agoPhrase('2026-09-08T08:00:00.000Z', NOW)).toBe('today')
    expect(agoPhrase('2026-09-07T08:00:00.000Z', NOW)).toBe('yesterday')
    expect(agoPhrase('2026-09-05T09:00:00.000Z', NOW)).toBe('3 days ago')
    expect(agoPhrase('2026-08-09T09:00:00.000Z', NOW)).toBe('4 weeks ago')
    expect(agoPhrase('2026-03-08T09:00:00.000Z', NOW)).toBe('6 months ago')
  })

  it('returns null rather than guessing when the timestamp is missing or ahead', () => {
    expect(agoPhrase(null, NOW)).toBe(null)
    expect(agoPhrase('2026-10-01T09:00:00.000Z', NOW)).toBe(null)
  })

  it('labels a day the way it gets written on a whiteboard', () => {
    expect(dayLabel('2026-09-19T14:00:00.000Z', 'America/New_York')).toBe('Sat 19 Sep')
    expect(dayLabel(null)).toBe(null)
    expect(dayLabel('not a date')).toBe(null)
  })

  it('does not drift with the runtime locale data', () => {
    // Node changed en-GB September from "Sep" to "Sept". The label is
    // built from a table, so it cannot move under a Node upgrade.
    expect(dayLabel('2026-09-19T14:00:00.000Z', 'UTC')).toBe('Sat 19 Sep')
    expect(dayLabel('2026-01-02T14:00:00.000Z', 'UTC')).toBe('Fri 2 Jan')
    expect(dayLabel('2026-12-25T14:00:00.000Z', 'UTC')).toBe('Fri 25 Dec')
  })

  it('renders the date in the venue timezone, not the server one', () => {
    // 00:30 UTC on the 13th is 20:30 on the 12th in New York. A server
    // running in UTC must not tell a Virginia coordinator it is Sunday.
    const iso = '2026-09-13T00:30:00.000Z'
    expect(dayLabel(iso, 'UTC')).toBe('Sun 13 Sep')
    expect(dayLabel(iso, 'America/New_York')).toBe('Sat 12 Sep')
    expect(timeLabel(iso, 'America/New_York')).toBe('8:30pm')
  })

  it('drops the time when none was set, rather than printing midnight', () => {
    expect(timeLabel('2026-09-12T00:00:00.000Z', 'UTC')).toBe(null)
    expect(dayTimeLabel('2026-09-12T00:00:00.000Z', 'UTC')).toBe('Sat 12 Sep')
    expect(dayTimeLabel('2026-09-12T14:05:00.000Z', 'UTC')).toBe('Sat 12 Sep, 2:05pm')
  })

  it('prefers today / tomorrow over a date', () => {
    expect(whenLabel('2026-09-08T15:00:00.000Z', NOW, 'UTC')).toBe('today')
    expect(whenLabel('2026-09-09T15:00:00.000Z', NOW, 'UTC')).toBe('tomorrow')
    expect(whenLabel('2026-09-12T15:00:00.000Z', NOW, 'UTC')).toBe('Sat 12 Sep')
    expect(whenLabel(null, NOW, 'UTC')).toBe(null)
  })
})

describe('channelLabel', () => {
  it('uses the name on the coordinator’s own invoices', () => {
    expect(channelLabel('gmail')).toBe('email')
    expect(channelLabel('knot')).toBe('The Knot')
    expect(channelLabel('weddingwire')).toBe('WeddingWire')
    expect(channelLabel('honeybook')).toBe('HoneyBook')
  })

  it('title-cases an unmapped channel rather than printing a slug', () => {
    expect(channelLabel('pinterest')).toBe('Pinterest')
    expect(channelLabel(null)).toBe('a message')
  })
})
