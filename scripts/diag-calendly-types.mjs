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

// Get a sample of New Event emails and categorise by event type
const { data } = await sb.from('interactions')
  .select('id, subject, timestamp, from_email, full_body, wedding_id')
  .eq('venue_id', RIXEY)
  .ilike('subject', 'New Event:%')
  .order('timestamp', { ascending: false })
  .limit(500)

const typeCounts = {}
const tourSamples = []

for (const r of data ?? []) {
  // Extract event type from subject: "New Event: Name - HH:MM day, Mon DD, YYYY - EVENT TYPE"
  const match = r.subject.match(/New Event:.*? - .*? - (.+)/)
  const eventType = match ? match[1].trim() : 'unknown'
  typeCounts[eventType] = (typeCounts[eventType] ?? 0) + 1

  if (/tour|visit|consult|site|showing/i.test(eventType) && tourSamples.length < 3) {
    // peek at whether body has discovery question
    const hasDiscovery = r.full_body && /where did you (hear|find)|how did you (hear|find)/i.test(r.full_body)
    tourSamples.push({
      subject: r.subject.slice(0, 80),
      type: eventType,
      date: r.timestamp?.slice(0, 10),
      hasDiscovery,
      bodySnippet: r.full_body?.slice(0, 400)
    })
  }
}

console.log('=== EVENT TYPES IN CALENDLY "New Event:" EMAILS ===')
for (const [t, n] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${t}`)
}

if (tourSamples.length) {
  console.log('\n=== TOUR SAMPLES ===')
  for (const s of tourSamples) {
    console.log(JSON.stringify(s, null, 2))
  }
} else {
  console.log('\nNo tour/site/consult events found — checking all event type names...')
}

// Also check if there are Calendly confirmation emails outside the "New Event:" pattern
const { data: other } = await sb.from('interactions')
  .select('subject, from_email')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%calendly%')
  .not('subject', 'ilike', 'New Event:%')
  .limit(20)

if (other?.length) {
  console.log('\n=== OTHER CALENDLY EMAILS (not "New Event:") ===')
  for (const r of other) console.log(`  ${r.from_email} | ${r.subject}`)
}
