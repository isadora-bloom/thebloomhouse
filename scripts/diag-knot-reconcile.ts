// Reconcile: are Knot leads really down, or is Bloom just not ingesting/attributing them?
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const ym = (d: any) => (d ? String(d).slice(0, 7) : '(none)')

async function page(sel: string, filt: (q: any) => any) {
  const out: any[] = []
  for (let f = 0; ; f += 1000) {
    let q = sb.from('interactions').select(sel).eq('venue_id', RIXEY).order('created_at', { ascending: true }).range(f, f + 999)
    q = filt(q)
    const { data, error } = await q
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    out.push(...data); if (data.length < 1000) break
  }
  return out
}

async function main() {
  // ALL interactions whose from_email mentions theknot — ANY direction — by month
  const knot = await page('from_email, direction, type, subject, timestamp, created_at, wedding_id, gmail_message_id',
    (q) => q.ilike('from_email', '%theknot%'))
  console.log(`Total interactions with theknot from_email: ${knot.length}`)

  const byMonth = new Map<string, { total: number; inbound: number; newInq: number; linked: number; unlinked: number }>()
  for (const r of knot as any[]) {
    const m = ym(r.timestamp ?? r.created_at)
    const e = byMonth.get(m) ?? { total: 0, inbound: 0, newInq: 0, linked: 0, unlinked: 0 }
    e.total++
    if (!r.direction || r.direction === 'inbound') e.inbound++
    const subj = String(r.subject ?? '')
    if (/new message|wants to learn|learn more/i.test(subj)) e.newInq++
    if (r.wedding_id) e.linked++; else e.unlinked++
    byMonth.set(m, e)
  }
  console.log('\nmonth     total  inbound  newInquiry  linked  unlinked')
  for (const m of [...byMonth.keys()].sort()) {
    if (m < '2025-09') continue
    const e = byMonth.get(m)!
    console.log(`${m}   ${String(e.total).padEnd(6)} ${String(e.inbound).padEnd(8)} ${String(e.newInq).padEnd(11)} ${String(e.linked).padEnd(7)} ${e.unlinked}`)
  }

  // Sync freshness: newest interaction overall + newest theknot interaction
  const newest = await sb.from('interactions').select('timestamp, created_at, from_email, type')
    .eq('venue_id', RIXEY).order('created_at', { ascending: false }).limit(1)
  console.log('\nNewest interaction in DB:', newest.data?.[0]?.created_at, '| from:', newest.data?.[0]?.from_email)
  const knotSorted = (knot as any[]).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  console.log('Newest theknot interaction in DB:', knotSorted[0]?.created_at, '| ts:', knotSorted[0]?.timestamp, '| subj:', String(knotSorted[0]?.subject).trim().slice(0, 50))
  console.log('5 most recent theknot rows:')
  for (const r of knotSorted.slice(0, 5)) console.log(`  ${r.created_at}  ${String(r.from_email).padEnd(45)} ${String(r.subject).trim().slice(0, 45)}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
