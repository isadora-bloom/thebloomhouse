/**
 * scripts/diag-may29-queue.ts
 * ============================
 * Read-only diagnostic for the 2026-05-29 morning resume. Pulls:
 *
 *   (1) Drafts queue summary for Rixey — counts by status, oldest pending,
 *       any approved-but-unsent stragglers (yesterday's drain was 5→0).
 *   (2) Candidate options for the 4 backlog disambiguations from yesterday's
 *       replay (Rachel / Emma Bergstedt / Jocelyn Wiese / Kristiana Leicht).
 *       Widens the search to ±7 days + venue scope so the operator can pick
 *       the right interaction.
 *   (3) /intel/identity-review queue depth — pending candidate_matches by
 *       confidence tier, plus the recent-merges window.
 *
 * Read-only. Refuses prod ref `jsxxgwprxuqgcauzlxcb` unless --allow-prod
 * is explicitly passed.
 *
 * USAGE
 * -----
 *   npx tsx scripts/diag-may29-queue.ts --allow-prod
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
} catch {
  // ok
}

const PROD_REF = 'jsxxgwprxuqgcauzlxcb'
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const allowProd = process.argv.includes('--allow-prod')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (url.includes(PROD_REF) && !allowProd) {
  console.error(`Refusing prod ref ${PROD_REF} without --allow-prod`)
  process.exit(1)
}

const supa = createClient(url, key, { auth: { persistSession: false } })

function fmt(d: string | null): string {
  if (!d) return '-'
  return new Date(d).toISOString().replace('T', ' ').slice(0, 16)
}

async function draftsSummary() {
  console.log('\n=== (1) DRAFTS QUEUE — Rixey ===')
  const statuses = ['pending', 'approved', 'sent', 'rejected'] as const
  for (const s of statuses) {
    const { count } = await supa
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', RIXEY)
      .eq('status', s)
    console.log(`  ${s.padEnd(10)} ${count ?? 0}`)
  }

  // Oldest pending
  const { data: oldestPending } = await supa
    .from('drafts')
    .select('id, to_email, subject, created_at, brain_used, confidence_score, auto_sent')
    .eq('venue_id', RIXEY)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(10)

  console.log(`\n  Oldest 10 pending:`)
  for (const d of oldestPending ?? []) {
    console.log(
      `    ${fmt(d.created_at as string)}  conf=${(d as any).confidence_score ?? '-'}  brain=${(d as any).brain_used}  → ${(d as any).to_email}  | ${((d as any).subject || '').slice(0, 60)}`,
    )
  }

  // Approved-but-unsent (yesterday's drain class)
  const { data: stuck } = await supa
    .from('drafts')
    .select('id, to_email, subject, approved_at, created_at, auto_sent, brain_used')
    .eq('venue_id', RIXEY)
    .eq('status', 'approved')
    .eq('auto_sent', false)
    .order('approved_at', { ascending: true })
    .limit(20)

  console.log(`\n  Approved-but-unsent (should be 0 after yesterday's drain):`)
  if (!stuck || stuck.length === 0) {
    console.log('    none')
  } else {
    for (const d of stuck) {
      console.log(
        `    approved=${fmt((d as any).approved_at)}  created=${fmt((d as any).created_at)}  → ${(d as any).to_email}  | ${((d as any).subject || '').slice(0, 60)}`,
      )
    }
  }

  // Last 24h activity
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count: createdLast24h } = await supa
    .from('drafts')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .gte('created_at', yesterday)
  const { count: sentLast24h } = await supa
    .from('drafts')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .eq('status', 'sent')
    .gte('sent_at', yesterday)
  console.log(`\n  Last 24h:  created=${createdLast24h ?? 0}  sent=${sentLast24h ?? 0}`)
}

async function candidates(label: string, tokens: string[], anchorDate: string, windowDays = 7) {
  console.log(`\n--- ${label} (anchor ${anchorDate}, ±${windowDays}d) ---`)
  const anchor = new Date(anchorDate + 'T12:00:00Z').getTime()
  const lo = new Date(anchor - windowDays * 86400_000).toISOString()
  const hi = new Date(anchor + windowDays * 86400_000).toISOString()

  // OR over from_email/from_name for any token
  const ors: string[] = []
  for (const t of tokens) {
    ors.push(`from_email.ilike.%${t}%`)
    ors.push(`from_name.ilike.%${t}%`)
    ors.push(`subject.ilike.%${t}%`)
  }
  const { data, error } = await supa
    .from('interactions')
    .select(
      'id, timestamp, direction, from_email, from_name, subject, type, intent_class, wedding_id, gmail_thread_id',
    )
    .eq('venue_id', RIXEY)
    .eq('direction', 'inbound')
    .gte('timestamp', lo)
    .lte('timestamp', hi)
    .or(ors.join(','))
    .order('timestamp', { ascending: false })
    .limit(30)

  if (error) {
    console.log(`  ERROR ${error.message}`)
    return
  }
  if (!data || data.length === 0) {
    console.log('  (no candidates in window)')
    return
  }

  // For each candidate, check if a non-rejected draft already exists
  const ids = data.map((d: any) => d.id)
  const { data: existingDrafts } = await supa
    .from('drafts')
    .select('interaction_id, status')
    .eq('venue_id', RIXEY)
    .in('interaction_id', ids)
    .neq('status', 'rejected')

  const draftedSet = new Set((existingDrafts ?? []).map((d: any) => d.interaction_id))

  for (const r of data) {
    const drafted = draftedSet.has((r as any).id) ? ' [DRAFTED]' : ''
    const subj = ((r as any).subject || '').slice(0, 60)
    console.log(
      `  ${fmt((r as any).timestamp)}  ${((r as any).from_name || '').slice(0, 24).padEnd(24)}  ${((r as any).from_email || '').slice(0, 36).padEnd(36)}  intent=${(r as any).intent_class || '-'}  type=${(r as any).type || '-'}  wedding=${((r as any).wedding_id || '').slice(0, 8)}  | ${subj}${drafted}`,
    )
  }
}

async function disambiguate() {
  console.log('\n=== (2) BACKLOG DISAMBIGUATION CANDIDATES ===')
  // From yesterday's replay-backlog-drafts.ts: Rachel, Emma Bergstedt are
  // in cohort 'calc'; Jocelyn Wiese is cohort 'urgent'. Kristiana Leicht
  // wasn't in that cohort definition — searching wider.
  await candidates('Rachel', ['rachel'], '2026-05-11', 7)
  await candidates('Emma Bergstedt', ['bergstedt', 'emma berg'], '2026-05-14', 14)
  await candidates('Jocelyn Wiese', ['jocelyn', 'wiese'], '2026-05-27', 10)
  await candidates('Kristiana Leicht', ['kristiana', 'leicht'], '2026-05-27', 30)
}

async function identityReview() {
  console.log('\n=== (3) /intel/identity-review QUEUE ===')

  // candidate_matches pending review
  const { count: totalCm } = await supa
    .from('candidate_matches')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
  console.log(`  candidate_matches total = ${totalCm ?? 0}`)

  const { data: byStatus } = await supa
    .from('candidate_matches')
    .select('status')
    .eq('venue_id', RIXEY)
  const counts: Record<string, number> = {}
  for (const r of byStatus ?? []) {
    const k = (r as any).status || 'null'
    counts[k] = (counts[k] || 0) + 1
  }
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    status=${k.padEnd(20)} ${v}`)
  }

  // Recent merges (last 7d)
  const sevenAgo = new Date(Date.now() - 7 * 86400_000).toISOString()
  const { count: mergesLast7d } = await supa
    .from('couple_merge_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .gte('created_at', sevenAgo)
  console.log(`\n  couple_merge_events last 7d = ${mergesLast7d ?? 0}`)
}

async function main() {
  console.log(`bloom-house diagnostic — ${new Date().toISOString()}`)
  console.log(`url=${url.replace(/^https:\/\//, '')}  venue=Rixey`)
  await draftsSummary()
  await disambiguate()
  await identityReview()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
