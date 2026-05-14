// Print the most recent person_merges rows for a venue so we can see
// what the backfill consolidated.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const limit = 10

async function main() {
  const { data, error } = await sb
    .from('person_merges')
    .select('id, kept_person_id, merged_person_id, tier, signals, merged_at, snapshot')
    .eq('venue_id', venueId)
    .order('merged_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error(error)
    process.exit(1)
  }
  console.log(`\nLast ${data?.length ?? 0} merges:\n`)
  for (const m of data ?? []) {
    const snap = ((m.snapshot ?? {}) as Record<string, unknown>).person as
      | Record<string, unknown>
      | undefined
    const first = snap?.first_name ?? ''
    const last = snap?.last_name ?? ''
    const email = snap?.email ?? ''
    const sig =
      Array.isArray(m.signals) && m.signals.length > 0
        ? (m.signals[0] as { type?: string; detail?: string }).detail
        : '(no signal)'
    console.log(`  ${m.merged_at}`)
    console.log(`    ${first} ${last} <${email}> merged into ${m.kept_person_id}`)
    console.log(`    rule: ${sig}`)
    console.log()
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
