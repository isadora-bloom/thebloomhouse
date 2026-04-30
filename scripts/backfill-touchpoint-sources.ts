// Repair wedding_touchpoints.source where the source was inherited
// from the wedding's legacy first-touch ('website', etc) instead of
// the actual channel the touchpoint occurred on.
//
// 2026-04-30: scoring-rescue + parts of email-pipeline used
// `wedding.source` when firing tour_booked / inquiry / email_reply
// touchpoints. For Calendly-routed leads with wedding.source =
// 'website' (legacy), the tour_booked touchpoint then renders as
// "via email System · Website" instead of "Calendly". Audit fix:
// look at the linked interaction's from_email (or metadata) and
// derive the correct source.
//
// Usage:
//   npx tsx scripts/backfill-touchpoint-sources.ts
//   npx tsx scripts/backfill-touchpoint-sources.ts --apply
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
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'

function inferSourceFromEmail(fromEmail: string | null): string | null {
  if (!fromEmail) return null
  const e = fromEmail.toLowerCase()
  if (e.includes('@calendly.com') || e.includes('@calendlymail.com')) return 'calendly'
  if (e.includes('@acuityscheduling.com')) return 'acuity'
  if (e.includes('@honeybook.com')) return 'honeybook'
  if (e.includes('@dubsado.com')) return 'dubsado'
  if (e.includes('@theknot.com') || e.includes('@knotemail.com')) return 'the_knot'
  if (e.includes('@weddingwire.com')) return 'wedding_wire'
  if (e.includes('@herecomestheguide.com')) return 'here_comes_the_guide'
  return null
}

async function main() {
  console.log(`\n=== Backfill touchpoint sources — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  const PAGE = 500
  let from = 0
  let scanned = 0
  let fixed = 0
  const samples: string[] = []

  for (;;) {
    const { data, error } = await sb
      .from('wedding_touchpoints')
      .select('id, touch_type, source, metadata, wedding_id')
      .eq('venue_id', venueId)
      .in('touch_type', ['tour_booked', 'calendly_booked', 'inquiry', 'email_reply', 'tour_conducted'])
      .range(from, from + PAGE - 1)
    if (error) { console.error(`fetch @${from}: ${error.message}`); break }
    const rows = (data ?? []) as Array<{ id: string; touch_type: string; source: string | null; metadata: { interaction_id?: string | null } | null; wedding_id: string }>
    if (rows.length === 0) break

    for (const r of rows) {
      scanned++
      // Try metadata.interaction_id first; if not present, follow
      // metadata.engagement_event_id → engagement_event.metadata.interaction_id
      // (inquiry touchpoints hold engagement_event_id rather than the
      // interaction_id directly).
      let interactionId = (r.metadata as { interaction_id?: string | null; engagement_event_id?: string | null } | null)?.interaction_id ?? null
      if (!interactionId) {
        const eeId = (r.metadata as { engagement_event_id?: string | null } | null)?.engagement_event_id
        if (eeId) {
          const { data: ee } = await sb
            .from('engagement_events')
            .select('metadata')
            .eq('id', eeId)
            .maybeSingle()
          interactionId = ((ee as { metadata: { interaction_id?: string | null } | null } | null)?.metadata?.interaction_id) ?? null
        }
      }
      // Last resort for inquiry touchpoints: the wedding's earliest
      // inbound interaction is the inquiry source.
      if (!interactionId && r.touch_type === 'inquiry') {
        const { data: firstInbound } = await sb
          .from('interactions')
          .select('id')
          .eq('wedding_id', r.wedding_id)
          .eq('direction', 'inbound')
          .not('timestamp', 'is', null)
          .order('timestamp', { ascending: true })
          .limit(1)
        interactionId = ((firstInbound?.[0] as { id: string } | undefined)?.id) ?? null
      }
      if (!interactionId) continue
      const { data: ix } = await sb
        .from('interactions')
        .select('from_email, gmail_message_id')
        .eq('id', interactionId)
        .maybeSingle()
      const ixRow = ix as { from_email: string | null } | null
      if (!ixRow) continue

      // Infer the touchpoint's correct source from the interaction.
      const inferred = inferSourceFromEmail(ixRow.from_email)
      if (!inferred) continue
      if (r.source === inferred) continue

      fixed++
      if (samples.length < 8) {
        samples.push(`  ${r.touch_type.padEnd(16)} ${r.id.slice(0, 8)}…  source: ${r.source ?? 'null'} → ${inferred}  (from ${ixRow.from_email})`)
      }
      if (apply) {
        const { error: updErr } = await sb
          .from('wedding_touchpoints')
          .update({ source: inferred })
          .eq('id', r.id)
        if (updErr) console.error(`  ${r.id}: ${updErr.message}`)
      }
    }

    if (rows.length < PAGE) break
    from += PAGE
  }

  console.log(`scanned:    ${scanned}`)
  console.log(`fixed:      ${fixed}`)
  if (samples.length > 0) {
    console.log(`\nfirst ${samples.length} samples:`)
    for (const s of samples) console.log(s)
  }
  if (!apply && fixed > 0) console.log(`\nDry-run complete. Re-run with --apply to write.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
