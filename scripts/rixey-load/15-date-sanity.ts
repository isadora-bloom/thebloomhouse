// Phase 10d: Date sanity check.
// The LL fix made weekly stats use inquiry_date (real signal time) not
// created_at (import time). Compare both for "this week" + "last week".
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  const now = new Date()
  const day = now.getUTCDay()
  // ISO week: Monday is start
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7))
  monday.setUTCHours(0, 0, 0, 0)
  const lastMonday = new Date(monday)
  lastMonday.setUTCDate(monday.getUTCDate() - 7)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 7)

  console.log(`This week: ${monday.toISOString().slice(0, 10)} → ${sunday.toISOString().slice(0, 10)}`)
  console.log(`Last week: ${lastMonday.toISOString().slice(0, 10)} → ${monday.toISOString().slice(0, 10)}`)
  console.log()

  for (const [label, start, end] of [
    ['this week', monday.toISOString(), sunday.toISOString()],
    ['last week', lastMonday.toISOString(), monday.toISOString()],
  ] as const) {
    const { count: byInquiry } = await sb
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', RIXEY_ID)
      .is('merged_into_id', null)
      .gte('inquiry_date', start)
      .lt('inquiry_date', end)

    const { count: byCreated } = await sb
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', RIXEY_ID)
      .is('merged_into_id', null)
      .gte('created_at', start)
      .lt('created_at', end)

    console.log(`${label}: by inquiry_date=${byInquiry}  by created_at=${byCreated}  diff=${(byCreated ?? 0) - (byInquiry ?? 0)}`)
  }

  // Also: how many imports landed today (created_at) vs signal-date today (inquiry_date)?
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const tomorrowStart = new Date(todayStart)
  tomorrowStart.setUTCDate(todayStart.getUTCDate() + 1)
  const { count: createdToday } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .gte('created_at', todayStart.toISOString())
  const { count: inquiryToday } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .gte('inquiry_date', todayStart.toISOString())

  console.log()
  console.log(`Today's count: by inquiry_date=${inquiryToday}  by created_at=${createdToday}`)
  console.log()
  console.log(`Net effect of the LL fix: weekly stats use real inquiry-time, so import-day artefacts don't inflate "this week".`)
}

main().catch((e) => { console.error(e); process.exit(1) })
