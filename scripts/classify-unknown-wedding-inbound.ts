#!/usr/bin/env tsx
/**
 * Targeted intent-classifier backfill for Step 5d.
 *
 * Walks every inbound interaction attached to a wedding that's
 * currently Unknown at Rixey + has intent_classified_at IS NULL, and
 * runs classifyInboundIntent on each. Cost is ~$0.001 per row.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main(): Promise<void> {
  const env: Record<string, string> = {}
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let v = m[2]
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    env[m[1]] = v
  }
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)

  const { classifyInboundIntent } = await import(
    '../src/lib/services/intel/inbound-intent-classifier'
  )

  const { data: venue } = await sb
    .from('venues')
    .select('id, name')
    .ilike('name', '%rixey%')
    .limit(1)
    .maybeSingle()
  if (!venue) {
    console.error('Rixey not found')
    process.exit(1)
  }
  console.log(`Venue: ${venue.name}`)

  const { data: rawWeddings } = await sb
    .from('weddings')
    .select('id')
    .eq('venue_id', venue.id)
    .is('non_couple_at', null)
    .is('merged_into_id', null)
    .limit(2000)
  const weddingIds: string[] = []
  for (const w of rawWeddings ?? []) {
    const { data: p1 } = await sb
      .from('people')
      .select('first_name')
      .eq('wedding_id', w.id as string)
      .eq('role', 'partner1')
      .is('merged_into_id', null)
      .limit(1)
    const first = p1?.[0]?.first_name as string | null | undefined
    if (!first || first === '(Unknown)' || first === '') {
      weddingIds.push(w.id as string)
    }
  }
  console.log(`Unknown weddings: ${weddingIds.length}`)
  if (weddingIds.length === 0) return

  const interactions: Array<{
    id: string
    venue_id: string
    type: string | null
    full_body: string | null
    subject: string | null
    from_email: string | null
  }> = []
  const BATCH = 200
  for (let i = 0; i < weddingIds.length; i += BATCH) {
    const batch = weddingIds.slice(i, i + BATCH)
    const { data } = await sb
      .from('interactions')
      .select('id, venue_id, type, full_body, subject, from_email')
      .in('wedding_id', batch)
      .eq('direction', 'inbound')
      .is('intent_classified_at', null)
      .limit(5000)
    for (const row of data ?? []) interactions.push(row as never)
  }
  console.log(`Unclassified inbound interactions: ${interactions.length}`)
  if (interactions.length === 0) return

  let classified = 0
  let errors = 0
  for (let i = 0; i < interactions.length; i++) {
    const row = interactions[i]
    const channel = (() => {
      switch (row.type) {
        case 'email': return 'email'
        case 'sms': return 'sms'
        case 'call':
        case 'call_summary': return 'call'
        case 'voicemail': return 'voicemail'
        case 'meeting': return 'meeting'
        case 'web_form': return 'web_form'
        default: return 'other'
      }
    })() as 'email' | 'sms' | 'call' | 'voicemail' | 'meeting' | 'web_form' | 'other' | 'brain_dump'
    try {
      await classifyInboundIntent({
        interactionId: row.id,
        body: row.full_body,
        subject: row.subject,
        venueId: row.venue_id,
        channel,
        fromEmail: row.from_email,
      })
      classified++
    } catch (err) {
      errors++
      console.warn(`  ${row.id}: ${err instanceof Error ? err.message : err}`)
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  progress: ${i + 1}/${interactions.length} (classified=${classified}, errors=${errors})`)
    }
  }

  console.log(`\n=== Done ===`)
  console.log(`  classified: ${classified}`)
  console.log(`  errors:     ${errors}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
