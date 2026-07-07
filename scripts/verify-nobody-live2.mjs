/**
 * Lightweight nobody-live verification.
 * Phase 2's wipe is only safe while Bloom House has zero real users.
 * Checks: couple portal registrations, recent couple activity, Sage conv turns from couples.
 */
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

let safe = true
const issues = []

// 1. Couples who have registered on the portal
const { data: registered } = await sb.from('weddings')
  .select('id, couple_registered_at, couple_invited_at')
  .eq('venue_id', RIXEY)
  .not('couple_registered_at', 'is', null)
const regCount = registered?.length ?? 0
if (regCount > 0) { safe = false; issues.push(`${regCount} couples have registered on the portal`) }
console.log(`Couple portal registrations: ${regCount}`)

// 2. Any couple_portal_tokens (active sessions)
const { data: tokens } = await sb.from('couple_portal_tokens')
  .select('id, created_at, expires_at')
  .gte('expires_at', new Date().toISOString())
  .limit(5)
const tokenCount = tokens?.length ?? 0
if (tokenCount > 0) { safe = false; issues.push(`${tokenCount} active couple portal tokens`) }
console.log(`Active couple portal tokens: ${tokenCount}`)

// 3. Sage conversations with couple-side turns (role='user' from couple context)
const { data: coupleTurns } = await sb.from('sage_conversations')
  .select('id, created_at, context_type')
  .eq('venue_id', RIXEY)
  .eq('context_type', 'couple')
  .limit(5)
const coupleConvCount = coupleTurns?.length ?? 0
if (coupleConvCount > 0) issues.push(`${coupleConvCount} couple-facing Sage conversations`)
console.log(`Couple-facing Sage conversations: ${coupleConvCount}`)

// 4. Recent drafts SENT (auto or manual) — signals real pipeline was serving real leads
const { data: recentSent } = await sb.from('drafts')
  .select('id, created_at, auto_sent, status')
  .eq('venue_id', RIXEY)
  .eq('status', 'sent')
  .gte('created_at', new Date(Date.now() - 7 * 86400_000).toISOString())
const sentCount = recentSent?.length ?? 0
console.log(`Drafts sent in last 7 days: ${sentCount}  (informational — Sage may be active even if portal isn't)`)

// 5. Weddings marked booked that were CREATED (not imported) — signal of live ingest
const { data: recentBooked } = await sb.from('weddings')
  .select('id, created_at, status, source_provenance')
  .eq('venue_id', RIXEY)
  .eq('status', 'booked')
  .gte('created_at', new Date(Date.now() - 14 * 86400_000).toISOString())
  .not('source_provenance', 'eq', 'honeybook_import')
console.log(`Booked weddings created in last 14d (not from HB import): ${recentBooked?.length ?? 0}`)

console.log()
if (safe) {
  console.log('✓ SAFE — no real couple users on the portal. Phase 2 wipe is clear to proceed.')
} else {
  console.log('✗ NOT SAFE —', issues.join('; '))
  console.log('  Stop and re-evaluate before wiping.')
}
