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

// Get full body for a genuine Knot inquiry — Paris Terrell (first contact, June 6)
const { data: paris } = await sb.from('interactions')
  .select('id, from_email, subject, full_body, extracted_identity, intent_class, lifecycle_folder, created_at')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%paris.terrell%')
  .not('subject', 'ilike', '%waiting%')
  .order('created_at')
  .limit(1)
  .maybeSingle()

if (paris) {
  console.log('=== PARIS TERRELL INQUIRY ===')
  console.log(`id: ${paris.id}`)
  console.log(`from: ${paris.from_email}`)
  console.log(`subject: ${paris.subject}`)
  console.log(`intent_class: ${paris.intent_class}`)
  console.log(`lifecycle_folder: ${paris.lifecycle_folder}`)
  console.log(`created_at: ${paris.created_at}`)
  console.log(`extracted_identity: ${JSON.stringify(paris.extracted_identity)?.slice(0, 300)}`)
  console.log(`\nFULL BODY (first 1500 chars):`)
  console.log(paris.full_body?.slice(0, 1500))
}

// Also check Maddie Sutton
const { data: maddie } = await sb.from('interactions')
  .select('id, from_email, subject, full_body, extracted_identity, intent_class, lifecycle_folder')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%maddie.sutton%')
  .limit(1)
  .maybeSingle()

if (maddie) {
  console.log('\n\n=== MADDIE SUTTON INQUIRY ===')
  console.log(`from: ${maddie.from_email}`)
  console.log(`subject: ${maddie.subject}`)
  console.log(`intent_class: ${maddie.intent_class}`)
  console.log(`lifecycle_folder: ${maddie.lifecycle_folder}`)
  console.log(`\nFULL BODY (first 1000 chars):`)
  console.log(maddie.full_body?.slice(0, 1000))
}
