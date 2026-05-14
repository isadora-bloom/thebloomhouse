#!/usr/bin/env node
/**
 * Delete every auto-learned no_draft filter whose pattern matches the
 * venue's own connected gmail domain. Companion to the inbox-filters.ts
 * guard added 2026-05-13 — the guard prevents future learning; this
 * script cleans up the historical damage.
 *
 * Bug class: RM-Lyndsey-Rivera. Calculator submissions arrive FROM
 * `*@rixeymanor.com` via reply-to spoof. The auto-learner saw 44/44
 * inbound from @rixeymanor.com produced no draft and learned a
 * no_draft filter → real leads got vetoed.
 *
 * Dry-run by default. Pass --apply to actually delete.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const apply = process.argv.includes('--apply')

function extractDomain(email) {
  if (!email || !email.includes('@')) return null
  return email.split('@')[1].toLowerCase().trim() || null
}

const { data: venues } = await sb.from('venues').select('id, name')
console.log(`Venues: ${venues?.length ?? 0}`)

let totalToDelete = 0
const toDelete = []

for (const v of venues ?? []) {
  // Own domains via gmail_connections + venue_own_emails (if exists)
  const ownDomains = new Set()
  const { data: conns } = await sb.from('gmail_connections').select('email_address').eq('venue_id', v.id)
  for (const c of conns ?? []) {
    const d = extractDomain(c.email_address)
    if (d) ownDomains.add(d)
  }
  try {
    const { data: own } = await sb.from('venue_own_emails').select('email').eq('venue_id', v.id)
    for (const c of own ?? []) {
      const d = extractDomain(c.email)
      if (d) ownDomains.add(d)
    }
  } catch {}

  if (ownDomains.size === 0) continue

  const { data: filters } = await sb
    .from('venue_email_filters')
    .select('id, pattern, pattern_type, action, source, note')
    .eq('venue_id', v.id)
    .eq('pattern_type', 'sender_domain')
    .eq('action', 'no_draft')
    .eq('source', 'learned')
  for (const f of filters ?? []) {
    const dom = f.pattern.toLowerCase()
    if (ownDomains.has(dom)) {
      console.log(`  [${v.name}] WILL DELETE filter ${f.id}: ${dom} (note: ${(f.note ?? '').slice(0, 80)})`)
      toDelete.push({ id: f.id, venueName: v.name, domain: dom })
      totalToDelete += 1
    }
  }
}

console.log(`\nTotal to delete: ${totalToDelete}`)
if (!apply) {
  console.log('Dry-run. Pass --apply to delete.')
  process.exit(0)
}

for (const t of toDelete) {
  const { error } = await sb.from('venue_email_filters').delete().eq('id', t.id)
  if (error) console.error(`  delete failed for ${t.id}: ${error.message}`)
  else console.log(`  deleted ${t.id} (${t.venueName} / ${t.domain})`)
}
console.log('\nDone.')
