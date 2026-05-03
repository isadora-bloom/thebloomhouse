// Probe each recent migration's distinguishing schema object to determine
// what's applied and what's not. Prints a status table.
//
// Each probe selects ONE column or table the migration introduces. If the
// select succeeds, the migration is applied. If PostgREST returns
// "column ... does not exist" / "schema cache" the migration is missing.
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

interface Probe {
  migration: string
  describe: string
  run: (sb: SupabaseClient) => Promise<{ applied: boolean; note?: string }>
}

const probes: Probe[] = [
  {
    migration: '188',
    describe: 'ON CONFLICT index fixes (uq_bar_planning_wedding_id, uq_packages_..., uq_fred_indicators_..._plain)',
    run: async (sb) => {
      const { error } = await sb.from('bar_planning').select('wedding_id').limit(1)
      if (error && /relation .* does not exist/i.test(error.message)) return { applied: false, note: 'bar_planning table missing' }
      return { applied: true, note: 'table reachable; index presence requires direct SQL probe' }
    },
  },
  {
    migration: '189',
    describe: 'government_events table (Stream ZZ)',
    run: async (sb) => {
      const { error } = await sb.from('government_events').select('id').limit(1)
      return { applied: !error || !/does not exist|schema cache/i.test(error.message) }
    },
  },
  {
    migration: '190',
    describe: 'weather_data extension columns (Stream ZZ)',
    run: async (sb) => {
      const { error } = await sb.from('weather_data').select('region, severity_score').limit(1)
      return { applied: !error || !/column .* does not exist/i.test(error.message), note: error?.message?.slice(0, 80) }
    },
  },
  {
    migration: '191',
    describe: 'identity backtrack columns (candidate_identities.backtrack_attempted_at, tangential_signals.backtrack_attempted_at)',
    run: async (sb) => {
      const { error } = await sb.from('candidate_identities').select('id, backtrack_attempted_at').limit(1)
      return { applied: !error || !/column .* does not exist/i.test(error.message), note: error?.message?.slice(0, 80) }
    },
  },
  {
    migration: '192',
    describe: 'signal_class column on interactions/tours/tangential_signals/lost_deals/attribution_events (Stream BBB)',
    run: async (sb) => {
      const { error } = await sb.from('interactions').select('id, signal_class').limit(1)
      return { applied: !error || !/column .* does not exist/i.test(error.message), note: error?.message?.slice(0, 80) }
    },
  },
  {
    migration: '194',
    describe: 'people.alias_emails text[] + GIN partial index (Stream EEE)',
    run: async (sb) => {
      const { error } = await sb.from('people').select('id, alias_emails').limit(1)
      return { applied: !error || !/column .* does not exist/i.test(error.message), note: error?.message?.slice(0, 80) }
    },
  },
  {
    migration: '195',
    describe: 'venue signature fields (ai_role_title, signature_tagline, signature_website, signature_phone, signature_text_capable) (Stream FFF)',
    run: async (sb) => {
      const { error } = await sb.from('venues').select('id, ai_role_title, signature_tagline, signature_website, signature_phone, signature_text_capable').limit(1)
      return { applied: !error || !/column .* does not exist/i.test(error.message), note: error?.message?.slice(0, 80) }
    },
  },
  {
    migration: '196',
    describe: 'tours.couple_display_name + sync trigger + index (Stream GGG)',
    run: async (sb) => {
      const { error } = await sb.from('tours').select('id, couple_display_name').limit(1)
      return { applied: !error || !/column .* does not exist/i.test(error.message), note: error?.message?.slice(0, 80) }
    },
  },
  {
    migration: '197',
    describe: 'cultural_moments influence_weight CHECK + correlation confidence backfill (Stream HHH)',
    run: async (sb) => {
      // The CHECK is hard to probe without an INSERT. Instead probe whether
      // the confidence backfill has run by counting correlation insights
      // with NULL/0 confidence AND data_points.r populated. After 197 this
      // count should be 0 (or close).
      const { count, error } = await sb
        .from('intelligence_insights')
        .select('id', { count: 'exact', head: true })
        .in('insight_type', ['correlation', 'correlation_narration'])
        .or('confidence.is.null,confidence.eq.0')
        .not('data_points->r', 'is', null)
      if (error) return { applied: false, note: `probe failed: ${error.message.slice(0, 80)}` }
      return {
        applied: (count ?? 0) === 0,
        note: count === 0 ? 'no rows with NULL/0 confidence + r → backfill applied' : `${count} correlation rows still NULL/0 confidence → backfill not applied`,
      }
    },
  },
]

async function main() {
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  console.log('Migration status (probed against live Supabase, service role)\n')
  console.log('mig  status        description')
  console.log('---  ------------  -----------')
  for (const p of probes) {
    try {
      const { applied, note } = await p.run(sb)
      const status = applied ? '✓ applied   ' : '✗ NOT APPLIED'
      console.log(`${p.migration}  ${status}  ${p.describe}`)
      if (note) console.log(`                      ${note}`)
    } catch (e) {
      console.log(`${p.migration}  ? error      ${p.describe}`)
      console.log(`                      ${(e as Error).message.slice(0, 120)}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
