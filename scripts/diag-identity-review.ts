/**
 * Read-only breakdown of /intel/identity-review queue depth so the
 * operator can triage. Pulls confidence-tier histogram + age buckets +
 * source breakdown for the 338 candidate_matches on Rixey.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

try {
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
} catch {}

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function describeColumns() {
  const { data } = await supa.from('candidate_matches').select('*').eq('venue_id', RIXEY).limit(1)
  if (data && data.length > 0) {
    console.log('Sample row columns:', Object.keys(data[0] as object).join(', '))
    console.log('Sample row:', JSON.stringify(data[0], null, 2).slice(0, 1200))
  }
}

async function bucketize() {
  const { data } = await supa
    .from('candidate_matches')
    .select('*')
    .eq('venue_id', RIXEY)
    .limit(1000)
  if (!data) return
  console.log(`\n  Total returned: ${data.length}`)

  // Confidence tier
  const confBucket: Record<string, number> = {}
  // Age bucket
  const ageBucket: Record<string, number> = { '<1d': 0, '1-7d': 0, '7-30d': 0, '>30d': 0 }
  // Source
  const srcBucket: Record<string, number> = {}
  // Reviewed status
  const reviewedBucket: Record<string, number> = {}

  const now = Date.now()
  for (const r of data as any[]) {
    const conf = r.confidence_tier ?? 'null'
    confBucket[String(conf)] = (confBucket[String(conf)] || 0) + 1

    const ts = r.created_at ?? r.detected_at ?? r.updated_at
    if (ts) {
      const ageDays = (now - new Date(ts).getTime()) / 86400_000
      if (ageDays < 1) ageBucket['<1d']++
      else if (ageDays < 7) ageBucket['1-7d']++
      else if (ageDays < 30) ageBucket['7-30d']++
      else ageBucket['>30d']++
    }

    // matcher_reason format: "score=95 tier=medium :: partner_email=95"
    const reason = String(r.matcher_reason || 'unknown')
    const ruleMatch = reason.match(/:: ([a-z_]+)=/i)
    const rule = ruleMatch ? ruleMatch[1] : reason.split('::')[0].trim().slice(0, 40)
    srcBucket[rule] = (srcBucket[rule] || 0) + 1

    const rev = r.resolution ? `resolved:${r.resolution}` : 'pending'
    reviewedBucket[rev] = (reviewedBucket[rev] || 0) + 1
  }

  console.log('\n  By confidence/tier:')
  for (const [k, v] of Object.entries(confBucket).sort()) console.log(`    ${k.padEnd(12)} ${v}`)

  console.log('\n  By age:')
  for (const [k, v] of Object.entries(ageBucket)) console.log(`    ${k.padEnd(12)} ${v}`)

  console.log('\n  By source/match_type:')
  for (const [k, v] of Object.entries(srcBucket).sort((a, b) => b[1] - a[1]))
    console.log(`    ${k.padEnd(40)} ${v}`)

  console.log('\n  By reviewed status:')
  for (const [k, v] of Object.entries(reviewedBucket)) console.log(`    ${k.padEnd(12)} ${v}`)
}

async function main() {
  console.log(`identity-review diag for Rixey — ${new Date().toISOString()}`)
  await describeColumns()
  await bucketize()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
