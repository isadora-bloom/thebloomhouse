import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const { data: couples } = await supabase
  .from('couples')
  .select('id, primary_contact_name, source_wedding_id')
  .eq('venue_id', VENUE_ID)
  .not('primary_contact_name', 'is', null)

const nospaces = (couples ?? []).filter(c =>
  c.primary_contact_name &&
  !c.primary_contact_name.includes(' ') &&
  c.primary_contact_name !== 'Unnamed couple' &&
  /[A-Z].*[a-z]/.test(c.primary_contact_name)
)

console.log(`Couples with no-space names: ${nospaces.length}`)
console.log('Samples:', nospaces.slice(0, 12).map(c => c.primary_contact_name))

let fixed = 0, fromPeople = 0, camelFixed = 0

for (const couple of nospaces) {
  let newName = null

  if (couple.source_wedding_id) {
    const { data: people } = await supabase
      .from('people')
      .select('first_name, last_name, role')
      .eq('wedding_id', couple.source_wedding_id)
      .in('role', ['partner1', 'partner2'])
      .not('first_name', 'is', null)
      .order('role')

    if (people && people.length > 0) {
      const p1 = people.find(p => p.role === 'partner1')
      if (p1 && p1.first_name) {
        const parts = [p1.first_name, p1.last_name].filter(Boolean).join(' ').trim()
        if (parts && parts.includes(' ')) { newName = parts; fromPeople++ }
      }
    }
  }

  if (!newName) {
    const split = couple.primary_contact_name.replace(/([a-z])([A-Z])/g, '$1 $2')
    if (split !== couple.primary_contact_name) { newName = split; camelFixed++ }
  }

  if (newName) {
    const { error } = await supabase
      .from('couples')
      .update({ primary_contact_name: newName })
      .eq('id', couple.id)
    if (!error) {
      fixed++
      console.log(`  Fixed: "${couple.primary_contact_name}" -> "${newName}"`)
    } else {
      console.log(`  Error for ${couple.id}: ${error.message}`)
    }
  } else {
    console.log(`  Could not fix: "${couple.primary_contact_name}"`)
  }
}

console.log(`\nTotal fixed: ${fixed} (${fromPeople} from people table, ${camelFixed} from CamelCase split)`)
