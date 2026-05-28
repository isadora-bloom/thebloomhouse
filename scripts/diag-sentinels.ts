/**
 * Show 5 sample "no candidate couple" sentinels with their underlying
 * touchpoint detail so the operator knows what they're looking at.
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

async function main() {
  const { data: sentinels } = await supa
    .from('candidate_matches')
    .select('id, primary_record_id, secondary_record_id, matcher_reason, created_at')
    .eq('venue_id', RIXEY)
    .ilike('matcher_reason', '%no candidate couple%')
    .is('resolved_at', null)
    .limit(8)

  console.log(`Sampling ${(sentinels ?? []).length} sentinel rows:\n`)

  for (const s of sentinels ?? []) {
    const isSelfPair = (s as any).primary_record_id === (s as any).secondary_record_id
    const tpId = (s as any).secondary_record_id
    const { data: tp } = await supa
      .from('touchpoints')
      .select('id, channel, action_type, source_address, raw_payload, occurred_at')
      .eq('id', tpId)
      .maybeSingle()

    console.log(`--- candidate_match ${(s as any).id} ---`)
    console.log(`  self-pair? ${isSelfPair}`)
    console.log(`  reason: ${(s as any).matcher_reason}`)
    if (tp) {
      const t = tp as any
      const payloadKeys = t.raw_payload ? Object.keys(t.raw_payload).slice(0, 5).join(',') : ''
      console.log(
        `  touchpoint: channel=${t.channel} action=${t.action_type} source=${t.source_address || '-'}`,
      )
      console.log(`    occurred=${t.occurred_at}  payload-keys=${payloadKeys}`)
      // Look at a bit of raw_payload that hints at provenance
      if (t.raw_payload?.from_email) console.log(`    from_email=${t.raw_payload.from_email}`)
      if (t.raw_payload?.subject) console.log(`    subject="${String(t.raw_payload.subject).slice(0, 80)}"`)
      if (t.raw_payload?.gmail_message_id) console.log(`    gmail_message_id=${t.raw_payload.gmail_message_id}`)
    } else {
      console.log(`  (touchpoint ${tpId} not found)`)
    }
    console.log('')
  }

  // Aggregate: of all sentinels, how many have a *.reminder@ underlying touchpoint?
  const { data: all } = await supa
    .from('candidate_matches')
    .select('secondary_record_id, matcher_reason')
    .eq('venue_id', RIXEY)
    .ilike('matcher_reason', '%no candidate couple%')
    .is('resolved_at', null)
    .limit(500)

  if (all && all.length > 0) {
    const tpIds = (all as any[]).map((r) => r.secondary_record_id)
    const { data: tps } = await supa
      .from('touchpoints')
      .select('id, channel, action_type, source_address, raw_payload')
      .in('id', tpIds)

    const buckets: Record<string, number> = {}
    let reminderCount = 0
    let personalCount = 0
    let unknownCount = 0
    for (const t of (tps ?? []) as any[]) {
      const src = String(t.source_address || '').toLowerCase()
      const fromEmail = String(t.raw_payload?.from_email || '').toLowerCase()
      const key =
        src.includes('.reminder@member.theknot.com') || fromEmail.includes('.reminder@member.theknot.com')
          ? 'knot_reminder_echo'
          : src.includes('@member.theknot.com') || fromEmail.includes('@member.theknot.com')
          ? 'knot_per_prospect_relay'
          : src.includes('zola.com') || fromEmail.includes('zola.com')
          ? 'zola'
          : src.includes('honeybook') || fromEmail.includes('honeybook')
          ? 'honeybook'
          : 'other'
      buckets[key] = (buckets[key] || 0) + 1
      if (key === 'knot_reminder_echo') reminderCount++
      if (key === 'knot_per_prospect_relay') personalCount++
      if (key === 'other') unknownCount++
    }

    console.log('Sentinel underlying-touchpoint sources (full population):')
    for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(30)} ${v}`)
    }
    console.log(`\n  Total scanned: ${tps?.length ?? 0}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
