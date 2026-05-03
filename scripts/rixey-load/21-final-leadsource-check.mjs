// Final check: lead_source distribution for Rixey post-fix.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    })
)

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const { data } = await sb
  .from('weddings')
  .select('lead_source')
  .eq('venue_id', RIXEY)
  .is('merged_into_id', null)

const counts = {}
let withHtml = 0
let withGarbage = 0
let nullCount = 0
for (const w of data ?? []) {
  if (w.lead_source == null) { nullCount++; continue }
  counts[w.lead_source] = (counts[w.lead_source] ?? 0) + 1
  if (/[<>]/.test(w.lead_source)) withHtml++
  if (/(view event|pro tip|http)/i.test(w.lead_source)) withGarbage++
}
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
console.log(`Total active: ${(data ?? []).length}`)
console.log(`null lead_source: ${nullCount}`)
console.log(`HTML in lead_source: ${withHtml}`)
console.log(`Garbage (Calendly-footer / URL): ${withGarbage}`)
console.log()
console.log('lead_source distribution (top 20):')
for (const [src, n] of sorted.slice(0, 20)) {
  console.log(`  ${src.padEnd(20)} ${String(n).padStart(4)}`)
}
