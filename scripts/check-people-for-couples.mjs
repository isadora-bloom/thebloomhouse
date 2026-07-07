import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const { data: couples } = await supabase
  .from('couples')
  .select('id, primary_contact_name, source_wedding_id')
  .eq('venue_id', VENUE_ID)
  .not('primary_contact_name', 'is', null)

const problematic = ['Juliapfund','Paynetolerance','Schwabd','Ashleycope','Mjblaesing','Shepardca','Barfelldgs','Phmartino','Lyndseyrivera','Racheljessica','Parandjul','Kayleighkolz']
const targets = (couples ?? []).filter(c => problematic.includes(c.primary_contact_name))

for (const c of targets) {
  if (!c.source_wedding_id) {
    console.log(`"${c.primary_contact_name}" -> no wedding id`)
    continue
  }
  const { data: p } = await supabase
    .from('people')
    .select('first_name, last_name, role, email')
    .eq('wedding_id', c.source_wedding_id)
    .order('role')
  const info = (p ?? []).map(x => `${x.role}: "${x.first_name || ''} ${x.last_name || ''}".trim <${x.email || ''}>`).join(' | ') || 'no people'
  console.log(`"${c.primary_contact_name}" -> ${info}`)
}
