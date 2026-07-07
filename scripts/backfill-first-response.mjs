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

// Get earliest outbound interaction per wedding (where wedding_id is set)
const { data: outbound } = await supabase
  .from('interactions')
  .select('wedding_id, timestamp')
  .eq('venue_id', VENUE_ID)
  .eq('direction', 'outbound')
  .not('wedding_id', 'is', null)
  .order('timestamp', { ascending: true })

const earliestOutbound = {}
for (const r of outbound ?? []) {
  if (!earliestOutbound[r.wedding_id]) earliestOutbound[r.wedding_id] = r.timestamp
}

// Get weddings that need first_response_at
const { data: weds } = await supabase
  .from('weddings')
  .select('id, inquiry_date, first_response_at')
  .eq('venue_id', VENUE_ID)
  .is('first_response_at', null)
  .not('inquiry_date', 'is', null)

let filled = 0, skipped = 0
for (const w of weds ?? []) {
  const earliest = earliestOutbound[w.id]
  if (!earliest || earliest <= w.inquiry_date) { skipped++; continue }

  const { error } = await supabase
    .from('weddings')
    .update({ first_response_at: earliest })
    .eq('id', w.id)
    .is('first_response_at', null) // guard: don't overwrite if somehow set
  if (error) {
    console.log(`  ERR ${w.id}: ${error.message}`)
  } else {
    filled++
    console.log(`  filled: wedding ${w.id} inquiry=${w.inquiry_date?.slice(0,10)} first_response=${earliest.slice(0,16)}`)
  }
}

console.log(`\nDone: filled=${filled}, skipped=${skipped}`)
