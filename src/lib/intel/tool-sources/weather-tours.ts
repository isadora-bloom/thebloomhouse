/**
 * Bad weather vs tour outcomes. NOVEMBER-PLAN.md wave 2, W14. Battery Q10.
 *
 * Joins `tours` (scheduled_at, outcome) to `weather_data` (venue_id, date)
 * on the tour's scheduled day, the same join src/lib/services/insights/
 * weather-cancellation.ts and src/lib/services/cohort/weather.ts already
 * run for their own narrower questions. This one answers the battery
 * question's three parts directly: no-show rate, reschedule rate, and
 * "converts worse even if they show up" (booked rate conditional on the
 * tour actually happening), split bad-weather vs fair-weather.
 *
 * Per NOVEMBER-PLAN.md: if the venue has no weather history stored at
 * all, this says so (`enoughData: false`, reason exactly "no weather
 * history stored") rather than reaching out for a live forecast.
 */
import type { IntelToolSource, ToolSourceDeps } from './types'
import { insufficient } from './types'

/** Below this many tours in a bucket, a rate is noise. Mirrors
 *  MIN_BUCKET_TOURS in weather-cancellation.ts. */
const MIN_BUCKET_TOURS = 5

interface TourRow {
  scheduled_at: string | null
  outcome: string | null
}

interface WeatherRow {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
}

/** Same threshold set as weather-cancellation.ts / cohort/weather.ts:
 *  measurable precipitation or a temperature extreme. */
function isBadWeather(w: WeatherRow): boolean {
  if (w.precipitation !== null && Number(w.precipitation) >= 0.1) return true
  if (w.high_temp !== null && Number(w.high_temp) >= 95) return true
  if (w.low_temp !== null && Number(w.low_temp) <= 25) return true
  if (w.high_temp !== null && Number(w.high_temp) <= 35) return true
  return false
}

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null
}

interface Bucket {
  total: number
  noShow: number
  rescheduled: number
  /** Tour actually happened: outcome is completed, booked, or lost (a
   *  deal that died AFTER the tour still means the couple showed up). */
  showedUp: number
  booked: number
}

function emptyBucket(): Bucket {
  return { total: 0, noShow: 0, rescheduled: 0, showedUp: 0, booked: 0 }
}

function summarise(b: Bucket) {
  const enoughForRates = b.total >= MIN_BUCKET_TOURS
  const enoughForConversion = b.showedUp >= MIN_BUCKET_TOURS
  return {
    n: b.total,
    enoughData: enoughForRates,
    ...(enoughForRates
      ? {}
      : { reason: `fewer than ${MIN_BUCKET_TOURS} tours matched to a weather day in this bucket` }),
    noShowRatePct: enoughForRates ? pct(b.noShow, b.total) : null,
    rescheduleRatePct: enoughForRates ? pct(b.rescheduled, b.total) : null,
    showedUp: b.showedUp,
    convertedRatePct: enoughForConversion ? pct(b.booked, b.showedUp) : null,
  }
}

async function run(
  venueId: string,
  _args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const { data: weatherRows, error: weatherErr } = await deps.supabase
    .from('weather_data')
    .select('date, high_temp, low_temp, precipitation')
    .eq('venue_id', venueId)
    .limit(5000)

  if (weatherErr) {
    return { n: 0, enoughData: false, reason: `weather_data read failed: ${weatherErr.message}` }
  }

  const weather = (weatherRows ?? []) as WeatherRow[]
  if (weather.length === 0) {
    // Exact wording per NOVEMBER-PLAN.md: don't fetch live weather, say
    // plainly there is no history to join against.
    return insufficient(0, 'no weather history stored')
  }

  const byDate = new Map<string, WeatherRow>()
  for (const w of weather) byDate.set(String(w.date).slice(0, 10), w)

  const { data: tourRows, error: tourErr } = await deps.supabase
    .from('tours')
    .select('scheduled_at, outcome')
    .eq('venue_id', venueId)
    .not('scheduled_at', 'is', null)
    .not('outcome', 'is', null)
    .neq('outcome', 'pending')
    .limit(5000)

  if (tourErr) {
    return { n: 0, enoughData: false, reason: `tours read failed: ${tourErr.message}` }
  }

  const tours = (tourRows ?? []) as TourRow[]
  const bad = emptyBucket()
  const fair = emptyBucket()
  let matched = 0

  for (const t of tours) {
    if (!t.scheduled_at) continue
    const day = t.scheduled_at.slice(0, 10)
    const w = byDate.get(day)
    if (!w) continue
    matched++

    const bucket = isBadWeather(w) ? bad : fair
    bucket.total++
    if (t.outcome === 'no_show') bucket.noShow++
    if (t.outcome === 'rescheduled') bucket.rescheduled++
    if (t.outcome === 'completed' || t.outcome === 'booked' || t.outcome === 'lost') {
      bucket.showedUp++
      if (t.outcome === 'booked') bucket.booked++
    }
  }

  if (matched === 0) {
    return insufficient(
      0,
      `${tours.length} tours and ${weather.length} weather days on record for this venue, but none ` +
        'of the tour dates overlap the weather history yet',
    )
  }

  return {
    n: matched,
    enoughData: true,
    toursConsidered: tours.length,
    weatherDaysOnRecord: weather.length,
    badWeather: summarise(bad),
    fairWeather: summarise(fair),
  }
}

export const weatherToursToolSource: IntelToolSource = {
  tool: {
    name: 'get_weather_tour_outcomes',
    description:
      'Scheduled tours joined to the weather on the day of the tour: no-show rate, reschedule rate, ' +
      'and the booked rate among tours that actually happened, split bad weather (measurable rain or ' +
      'snow, or a temperature extreme) versus fair weather. If this venue has no weather history stored, ' +
      "or none of it overlaps a tour date, says so rather than guessing or fetching a live forecast. " +
      'Use this for whether bad weather hurts tour attendance, reschedules, or conversion.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  subjects: [
    'weather and tour no-shows',
    'weather and tour outcomes',
    'bad weather effect on tours',
    'does rain hurt tour conversion',
  ],
  batteryQuestions: ['10'],
  run,
}
