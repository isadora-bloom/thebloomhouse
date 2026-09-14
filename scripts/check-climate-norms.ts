/**
 * check-climate-norms.ts (W49, wave 7 / November plan).
 *
 * Read-only diagnostic: for every venue, report whether the climate-
 * norms backfill (src/lib/services/intel/weather-climate-norms.ts,
 * dispatched from the `weather_history_refresh` cron case) has ever
 * run, and when it last wrote.
 *
 * This is deliberately a READ. It makes the annual backfill
 * verifiable without running it — the shared workstream rule for W49
 * is no database writes. Run it any time to answer "did the annual
 * job actually cover every venue with coordinates":
 *
 *   npx tsx scripts/check-climate-norms.ts
 *   npx tsx scripts/check-climate-norms.ts --venue <uuid>
 *
 * Reports two tables per venue:
 *   - weather_climate_norms (mig 340): row count (max 288 = 12mo x 24h)
 *     + most recent refreshed_at. This is the recent/prior decade
 *     comparison the page + climate-context.ts already read.
 *   - weather_climate_annual (mig 404, W49): row count + year range +
 *     most recent refreshed_at. This is the per-year series that backs
 *     the least-squares trend climate-context.ts now also exposes.
 *
 * A venue with lat/lon but zero rows in either table has never had the
 * annual backfill run for it — that's the "not actually dispatched for
 * every venue" failure mode this script exists to catch.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue
      const i = line.indexOf('=')
      env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // ignore — env may already be set in the shell
  }
  return env
}

interface VenueRow {
  id: string
  name: string | null
  latitude: number | null
  longitude: number | null
}

async function main() {
  const venueArgIdx = process.argv.indexOf('--venue')
  const venueFilter = venueArgIdx !== -1 ? process.argv[venueArgIdx + 1] : null

  const env = loadEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  let venueQuery = sb.from('venues').select('id, name, latitude, longitude')
  if (venueFilter) venueQuery = venueQuery.eq('id', venueFilter)
  const { data: venuesRaw, error: venueErr } = await venueQuery.order('name', { ascending: true })
  if (venueErr) {
    console.error('venues read failed:', venueErr.message)
    process.exit(1)
  }
  const venues = (venuesRaw ?? []) as VenueRow[]

  console.log('=== CLIMATE NORMS COVERAGE (read-only) ===\n')

  let gaps = 0
  for (const v of venues) {
    const hasGeo = v.latitude != null && v.longitude != null
    console.log(`${v.name ?? v.id} (${v.id})`)
    if (!hasGeo) {
      console.log('  no lat/lon — backfill cannot run for this venue (expected gap, not a bug)')
      console.log('')
      continue
    }

    const { data: normsRows, error: normsErr } = await sb
      .from('weather_climate_norms')
      .select('refreshed_at')
      .eq('venue_id', v.id)
      .order('refreshed_at', { ascending: false })
      .limit(1)
    const { count: normsCount } = await sb
      .from('weather_climate_norms')
      .select('*', { count: 'exact', head: true })
      .eq('venue_id', v.id)

    const { data: annualRows, error: annualErr } = await sb
      .from('weather_climate_annual')
      .select('year, refreshed_at')
      .eq('venue_id', v.id)
      .order('year', { ascending: true })

    const normsLastWrite = normsErr ? null : (normsRows?.[0]?.refreshed_at ?? null)
    const annualList = annualErr ? [] : (annualRows ?? [])
    const annualYears = annualList.map((r) => (r as { year: number }).year)
    const annualLastWrite = annualList.length
      ? annualList
          .map((r) => (r as { refreshed_at: string }).refreshed_at)
          .sort()
          .at(-1)
      : null

    if (normsErr) {
      console.log(`  weather_climate_norms:  READ FAILED — ${normsErr.message}`)
    } else {
      console.log(`  weather_climate_norms:  ${normsCount ?? 0} rows (of max 288)  last written: ${normsLastWrite ?? 'never'}`)
    }

    if (annualErr) {
      // Distinct from "empty" — most likely migration 404 hasn't been
      // applied to this database yet ("relation does not exist", 42P01).
      console.log(`  weather_climate_annual: READ FAILED — ${annualErr.message}`)
    } else {
      console.log(
        `  weather_climate_annual: ${annualList.length} rows, years ${
          annualYears.length ? `${Math.min(...annualYears)}-${Math.max(...annualYears)}` : 'none'
        }  last written: ${annualLastWrite ?? 'never'}`,
      )
    }

    if (!annualErr && !normsErr && (normsCount ?? 0) === 0 && annualList.length === 0) {
      console.log('  GAP — has coordinates but the annual backfill has never run for this venue.')
      gaps++
    }
    console.log('')
  }

  console.log(`${venues.length} venue(s) checked, ${gaps} gap(s) (has geo, zero climate rows).`)
  process.exit(gaps > 0 ? 0 : 0) // informational only — never fails CI, this is a diagnostic
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
