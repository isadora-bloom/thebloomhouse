// Look hard at the 12 fixup-eligible weddings: who they are, what
// interactions they have, what the body content looks like. Help the
// user decide: AI-extract / coordinator-fill / leave as Pre-Bloom.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

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

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const DOLLAR_RE = /\$\s?([\d,]+(?:\.\d{2})?)/g

async function main() {
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: rawWed, error } = await sb
    .from('weddings')
    .select('id, source, status, booking_value, booked_at, wedding_date, inquiry_date, merged_into_id, crm_source, lead_source')
    .eq('venue_id', RIXEY)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
  if (error) throw error
  type W = { id: string; source: string|null; status: string; booking_value: number|null; booked_at: string|null; wedding_date: string|null; inquiry_date: string|null; merged_into_id: string|null; crm_source: string|null; lead_source: string|null }
  const weddings = (rawWed ?? []) as W[]

  const fixups = weddings.filter(w =>
    !w.booking_value || w.booking_value === 0 || !w.source || !w.wedding_date
  )

  console.log(`\n=== ${fixups.length} fixup-eligible weddings ===\n`)
  for (const w of fixups) {
    // Get couple via people table.
    const { data: ppl } = await sb.from('people').select('first_name, last_name, role').eq('wedding_id', w.id).in('role', ['partner1', 'partner2'])
    type P = { first_name: string|null; last_name: string|null; role: string }
    const partners = (ppl ?? []) as P[]
    const p1 = partners.find(p => p.role === 'partner1')
    const p2 = partners.find(p => p.role === 'partner2')
    const couple = [p1?.first_name, p2?.first_name].filter(Boolean).join(' & ') || '(no names)'
    console.log(`${w.id.slice(0, 8)}…  ${couple}`)
    console.log(`  source=${w.source ?? 'NULL'}  crm_source=${w.crm_source ?? 'NULL'}  lead_source=${w.lead_source ?? 'NULL'}`)
    console.log(`  status=${w.status}  bv=${w.booking_value ?? 'NULL'}  weddingDate=${w.wedding_date ?? 'NULL'}  inquiryDate=${w.inquiry_date?.slice(0,10) ?? 'NULL'}  bookedAt=${w.booked_at?.slice(0,10) ?? 'NULL'}`)

    const { data: ixs } = await sb
      .from('interactions')
      .select('id, type, direction, subject, body_preview, full_body, from_email, from_name, timestamp')
      .eq('wedding_id', w.id)
      .order('timestamp', { ascending: true })
    type I = { id: string; type: string|null; direction: string|null; subject: string|null; body_preview: string|null; full_body: string|null; from_email: string|null; from_name: string|null; timestamp: string|null }
    const ix = (ixs ?? []) as I[]
    console.log(`  ${ix.length} interactions`)

    // Pull dollar amounts from any email body. Show the top 5.
    const dollarHits: { ts: string; subject: string; amount: string; from: string }[] = []
    for (const i of ix) {
      const text = `${i.subject ?? ''}\n${i.body_preview ?? ''}\n${i.full_body ?? ''}`
      const matches = text.matchAll(DOLLAR_RE)
      for (const m of matches) {
        const amt = m[1]!
        // Skip obvious noise: $0, $1, $5, $10 etc. that are likely shipping fees / unsubscribe links / tiny mentions.
        const num = Number(amt.replace(/,/g, ''))
        if (num >= 1000 && num <= 100000) {
          dollarHits.push({ ts: i.timestamp ?? '', subject: i.subject ?? '', amount: amt, from: i.from_email ?? '' })
        }
      }
    }
    if (dollarHits.length > 0) {
      console.log(`  DOLLAR HITS (>=\\$1000, <=\\$100k):`)
      for (const h of dollarHits.slice(0, 6)) {
        console.log(`    [${h.ts.slice(0,10)}] $${h.amount}  from=${h.from.slice(0,40)}  subj="${h.subject.slice(0, 60)}"`)
      }
      if (dollarHits.length > 6) console.log(`    ... and ${dollarHits.length - 6} more`)
    } else {
      // Show subject lines + from_email so we can judge if there's anything to backtrace from at all.
      console.log(`  no relevant dollar hits — subjects:`)
      for (const i of ix.slice(0, 6)) {
        console.log(`    [${(i.timestamp ?? '').slice(0,10)}] ${(i.direction ?? '?').padEnd(8)} from=${(i.from_email ?? '—').slice(0,30)}  subj="${(i.subject ?? '(no subj)').slice(0, 70)}"`)
      }
    }
    console.log()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
