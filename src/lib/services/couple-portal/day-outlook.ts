/**
 * What the weather is likely to do on their wedding day.
 *
 * W52 of NOVEMBER-PLAN.md wave 7. Bloom pulls a fourteen-day forecast
 * nightly and holds a decade of monthly normals for every venue, and a
 * couple could see neither. The only way weather reached them was by
 * asking the portal assistant a question, which means it only reached the
 * couples who thought to ask.
 *
 * Two modes, in this order, and never a third:
 *
 *   1. **Forecast** — the day is close enough that a real forecast row
 *      exists for it in `weather_data`. That is a forecast, and the card
 *      says so.
 *   2. **Typical** — it is not. The card falls back to the venue's own
 *      record for that month and says, plainly, that this is what the
 *      month is usually like and not a forecast. A couple planning
 *      eighteen months out deserves the honest version of that sentence,
 *      not a number that looks like a promise.
 *
 * When neither is available the card does not render. There is no third
 * mode where it guesses.
 *
 * It calls only the functions `src/lib/services/intel/weather.ts` and
 * `climate-context.ts` already export today and edits neither, because
 * W49 is rewriting parts of both in parallel.
 *
 * One more rule this file exists to hold: `ClimateContext.recentAnomalies`
 * carries `inquiriesDuring` / `toursDuring`, which are the venue's
 * business numbers. Those must never reach a couple (couple-rules.ts,
 * TENANT ISOLATION), so this module reads `monthProfile` and nothing
 * else off that object.
 *
 * The builder is pure and unit-tested in
 * `src/lib/services/couple-portal/__tests__/day-outlook.test.ts`.
 */

import { clientTerm } from '@/lib/copy/client-terms'

// ─────────────────────────────────────────────────────────────────────
// Facts
// ─────────────────────────────────────────────────────────────────────

export type DayOutlookMode = 'forecast' | 'typical' | 'none'

export interface DayOutlookFacts {
  mode: DayOutlookMode
  /** The wedding date this is about, ISO. Null when unknown. */
  date: string | null
  /** Forecast mode only. */
  forecast: {
    highTemp: number | null
    lowTemp: number | null
    precipitation: number | null
    conditions: string | null
  } | null
  /** Typical mode only, straight off `ClimateContext.monthProfile`. */
  typical: {
    monthLabel: string
    daytimeTempF: number | null
    daytimePrecipProbPct: number | null
  } | null
}

/** How far ahead a forecast row is worth believing. Open-Meteo gives the
 *  nightly job fourteen days, so a `weather_data` row further out than
 *  that is a stale one left behind by an earlier run rather than a
 *  forecast for this couple's day. */
export const FORECAST_HORIZON_DAYS = 14

export function emptyOutlook(date: string | null): DayOutlookFacts {
  return { mode: 'none', date, forecast: null, typical: null }
}

function daysAhead(dateIso: string, now: number): number {
  const t = Date.parse(dateIso.length === 10 ? `${dateIso}T12:00:00Z` : dateIso)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return Math.round((t - now) / 86_400_000)
}

/**
 * Read the forecast if there is one for the day, otherwise the month's
 * own record. Never throws: a weather outage returns `mode: 'none'` and
 * the card disappears, which is the right failure for a decoration on a
 * planning page.
 */
export async function loadDayOutlook(
  venueId: string,
  weddingDate: string | null | undefined,
  now: number,
): Promise<DayOutlookFacts> {
  const date = weddingDate?.trim() || null
  if (!venueId || !date) return emptyOutlook(date)

  const ahead = daysAhead(date, now)
  if (ahead >= 0 && ahead <= FORECAST_HORIZON_DAYS) {
    try {
      const { getWeatherForDateRange } = await import('@/lib/services/intel/weather')
      const rows = await getWeatherForDateRange(venueId, date, date)
      const row = rows.find((r) => r.date === date) ?? rows[0]
      if (row) {
        return {
          mode: 'forecast',
          date,
          forecast: {
            highTemp: row.high_temp,
            lowTemp: row.low_temp,
            precipitation: row.precipitation,
            conditions: row.conditions,
          },
          typical: null,
        }
      }
    } catch (err) {
      console.warn('[day-outlook] forecast lookup failed:', err)
    }
  }

  try {
    const { getVenueClimateContext } = await import('@/lib/services/intel/climate-context')
    const climate = await getVenueClimateContext(venueId, { date })
    // monthProfile ONLY. recentAnomalies carries the venue's inquiry and
    // tour counts and must not travel to a couple.
    const p = climate.monthProfile
    if (climate.available && p) {
      return {
        mode: 'typical',
        date,
        forecast: null,
        typical: {
          monthLabel: p.monthLabel,
          daytimeTempF: p.daytimeTempF,
          daytimePrecipProbPct: p.daytimePrecipProbPct,
        },
      }
    }
  } catch (err) {
    console.warn('[day-outlook] climate lookup failed:', err)
  }

  return emptyOutlook(date)
}

// ─────────────────────────────────────────────────────────────────────
// The card
// ─────────────────────────────────────────────────────────────────────

export interface DayOutlookCard {
  /** Small label above the headline. */
  label: string
  /** The number, already formatted. */
  headline: string
  /** One line under it, in the couple's own register. */
  body: string
  /** Says out loud which of the two modes this is. A couple must never
   *  have to work out whether they are reading a forecast or an average. */
  basis: string
  mode: Exclude<DayOutlookMode, 'none'>
}

function degrees(f: number | null): string | null {
  return f === null ? null : `${Math.round(f)}°F`
}

/** Rain in plain words. A number of inches means nothing to most people;
 *  "a good chance of rain" does. */
function rainPhrase(precipitation: number | null): string | null {
  if (precipitation === null) return null
  if (precipitation <= 0) return 'nothing in the way of rain'
  if (precipitation < 0.1) return 'a shower or two at most'
  if (precipitation < 0.5) return 'some rain about'
  return 'a properly wet day as it stands'
}

function chancePhrase(pct: number | null): string | null {
  if (pct === null) return null
  if (pct < 20) return 'and it is usually dry'
  if (pct < 40) return 'with the odd wet one'
  return 'and rain is fairly common'
}

/**
 * Pure. Turns the facts into the four strings the card renders, or null
 * when there is nothing honest to show.
 *
 * Every phrase a couple reads goes through `clientTerm` where the term
 * has a translation, so the one vocabulary file governs this surface too.
 * Conditions strings come from a weather API in whatever words it uses,
 * and `clientTerm` passes an unmapped term through unchanged, so nothing
 * is lost when there is no mapping.
 */
export function buildDayOutlookCard(facts: DayOutlookFacts): DayOutlookCard | null {
  if (facts.mode === 'forecast' && facts.forecast) {
    const high = degrees(facts.forecast.highTemp)
    const low = degrees(facts.forecast.lowTemp)
    if (!high && !low && !facts.forecast.conditions) return null

    const conditions = facts.forecast.conditions ? clientTerm(facts.forecast.conditions) : null
    const rain = rainPhrase(facts.forecast.precipitation)
    const bodyParts = [conditions, rain].filter(Boolean) as string[]

    return {
      label: 'Your wedding day',
      headline: high ?? low ?? (conditions as string),
      body:
        bodyParts.length > 0
          ? `${bodyParts.join(', ')}${low && high ? `, down to ${low} overnight` : ''}.`
          : 'The forecast is in, and there is nothing unusual in it.',
      basis: 'This is the actual forecast for your date, and it will move a little between now and then.',
      mode: 'forecast',
    }
  }

  if (facts.mode === 'typical' && facts.typical) {
    const temp = degrees(facts.typical.daytimeTempF)
    if (!temp && facts.typical.daytimePrecipProbPct === null) return null

    const chance = chancePhrase(facts.typical.daytimePrecipProbPct)
    return {
      label: 'Your wedding day',
      headline: temp ?? `${facts.typical.monthLabel} here`,
      body: `${facts.typical.monthLabel} here usually sits around ${temp ?? 'this'}${chance ? ` ${chance}` : ''}.`,
      basis:
        'Too far out for a forecast, so this is what the venue’s own record says the month is normally like.',
      mode: 'typical',
    }
  }

  return null
}
