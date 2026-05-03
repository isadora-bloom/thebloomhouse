// Register marketing_channels rows for Rixey so /intel/sources + ROI calc
// know what channels to compute over. Idempotent.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const channels = [
  { key: 'the_knot', label: 'The Knot', category: 'platform', is_active: true, notes: '$1,261/mo via WeddingPro (post Oct 2024 hike)' },
  { key: 'wedding_wire', label: 'WeddingWire', category: 'platform', is_active: false, notes: 'DROPPED Feb 2025 — refund processed Jan 2025' },
  { key: 'google', label: 'Google Ads', category: 'paid', is_active: true, notes: 'Escalated 6x from 2024-05 ($109) to 2026-04 ($1,817)' },
  { key: 'instagram', label: 'Instagram', category: 'social', is_active: true, notes: '' },
  { key: 'pinterest', label: 'Pinterest', category: 'social', is_active: true, notes: '' },
  { key: 'reddit', label: 'Reddit', category: 'social', is_active: true, notes: 'Test campaign $100/mo, started Feb 2026' },
  { key: 'here_comes_the_guide', label: 'Here Comes The Guide', category: 'platform', is_active: true, notes: '$125/mo (start date unknown)' },
  { key: 'referral', label: 'Word of Mouth / Referral', category: 'referral', is_active: true, notes: '' },
  { key: 'website', label: 'Direct Website', category: 'direct', is_active: true, notes: '' },
  { key: 'wedding_spot', label: 'Wedding Spot', category: 'platform', is_active: true, notes: '' },
  { key: 'junebug', label: 'Junebug', category: 'platform', is_active: true, notes: '' },
  { key: 'google_business', label: 'Google Business Profile', category: 'search', is_active: true, notes: '' },
  { key: 'bridal_show', label: 'Bridal Shows', category: 'event', is_active: true, notes: '' },
]

const { data: existing } = await sb.from('marketing_channels').select('id, key').eq('venue_id', RIXEY_ID)
const existingKeys = new Set((existing ?? []).map((r) => r.key.toLowerCase()))

let inserted = 0, skipped = 0, errors = 0
for (const ch of channels) {
  if (existingKeys.has(ch.key.toLowerCase())) { skipped++; continue }
  const { error } = await sb.from('marketing_channels').insert({
    venue_id: RIXEY_ID,
    key: ch.key,
    label: ch.label,
    category: ch.category,
    is_active: ch.is_active,
    notes: ch.notes,
  })
  if (error) { errors++; console.error(`${ch.key}: ${error.message}`) } else inserted++
}
console.log(`marketing_channels: inserted=${inserted} skipped=${skipped} errors=${errors}`)
