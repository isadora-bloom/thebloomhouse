import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const { data: remaining } = await sb.from('interactions')
  .select('id')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%@member.theknot.com')
  .is('wedding_id', null)
  .eq('direction', 'inbound')
  .eq('intent_class', 'new_inquiry')
  .gte('timestamp', '2026-01-01')

const { data: totalKnot } = await sb.from('interactions')
  .select('id, wedding_id')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%theknot%')
  .eq('direction', 'inbound')
  .gte('timestamp', '2026-01-01')

const linked2026 = (totalKnot ?? []).filter(r => r.wedding_id).length

console.log('=== KNOT FIX VERIFICATION ===')
console.log(`2026 Knot inbound: ${totalKnot?.length} total, ${linked2026} linked`)
console.log(`Remaining 2026 new_inquiry orphans on @member.theknot.com: ${remaining?.length}`)

const { data: newWeddings } = await sb.from('weddings')
  .select('id, status, inquiry_date, lead_source')
  .eq('venue_id', RIXEY)
  .eq('lead_source', 'the_knot')
  .gte('created_at', '2026-07-07')
  .order('inquiry_date')

console.log(`\nWeddings with lead_source=the_knot created today: ${newWeddings?.length}`)
