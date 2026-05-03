// One-shot parity run for Rixey (T5-Rixey-BBB initial validation).
//
// Mirrors the production service in src/lib/services/attribution-parity.ts
// + identity-cluster-attribution.ts so we can capture the day-zero
// agreement rate before the daily cron starts running.
//
// Run: node scripts/run-bbb-parity-once.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const SOURCE_LABEL_OVERRIDES = {
  the_knot: 'The Knot',
  wedding_wire: 'WeddingWire',
  weddingwire: 'WeddingWire',
  zola: 'Zola',
  here_comes_the_guide: 'Here Comes The Guide',
  herecomestheguide: 'Here Comes The Guide',
  website: 'Website',
  web_form: 'Website Form',
  venue_calculator: 'Venue Calculator',
  google: 'Google',
  google_business: 'Google Business',
  google_ads: 'Google Ads',
  instagram: 'Instagram',
  pinterest: 'Pinterest',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  direct: 'Direct',
  referral: 'Referral',
  walk_in: 'Walk-in',
  calendly: 'Calendly',
  acuity: 'Acuity',
  honeybook: 'HoneyBook',
  dubsado: 'Dubsado',
  other: 'Other',
}

function formatLabel(raw) {
  if (!raw) return null
  const k = String(raw).trim().toLowerCase()
  if (SOURCE_LABEL_OVERRIDES[k]) return SOURCE_LABEL_OVERRIDES[k]
  return k.split(/[_-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}

function canonicalisePlatform(sp) {
  if (!sp) return null
  const s = sp.toLowerCase().trim()
  if (s.includes('knot')) return 'the_knot'
  if (s.includes('weddingwire') || s.includes('wedding_wire')) return 'wedding_wire'
  if (s.includes('zola')) return 'zola'
  if (s.includes('instagram')) return 'instagram'
  if (s.includes('facebook')) return 'facebook'
  if (s.includes('pinterest')) return 'pinterest'
  if (s.includes('google')) return 'google'
  if (s.includes('here_comes_the_guide') || s.includes('hctg')) return 'here_comes_the_guide'
  if (s === 'website_form') return 'website'
  return s
}

function normHearSource(a) {
  const s = (a ?? '').toLowerCase().trim()
  if (!s) return null
  if (/knot/.test(s)) return 'the_knot'
  if (/wedding ?wire/.test(s)) return 'wedding_wire'
  if (/zola/.test(s)) return 'zola'
  if (/here ?comes/.test(s)) return 'here_comes_the_guide'
  if (/instagram|insta\b|ig\b/.test(s)) return 'instagram'
  if (/facebook|fb\b/.test(s)) return 'facebook'
  if (/google/.test(s)) return 'google'
  if (/pinterest/.test(s)) return 'pinterest'
  if (/referr|friend|family/.test(s)) return 'referral'
  if (/web|website/.test(s)) return 'website'
  return null
}

const PLATFORM_DOMAIN = {
  'theknot.com': 'the_knot',
  'mail.theknot.com': 'the_knot',
  'auth.theknot.com': 'the_knot',
  'member.theknot.com': 'the_knot',
  'weddingwire.com': 'wedding_wire',
  'mail.weddingwire.com': 'wedding_wire',
  'authsolic.com': 'wedding_wire',
  'zola.com': 'zola',
  'mail.zola.com': 'zola',
  'herecomestheguide.com': 'here_comes_the_guide',
  'wedsites.com': 'wedsites',
}

console.log('=== BBB parity scan: Rixey ===\n')
const t0 = Date.now()

// Pull all weddings with chain output.
const { data: weddings, error } = await sb.from('weddings')
  .select('id, lead_source, attribution_priority')
  .eq('venue_id', RIXEY)
  .is('merged_into_id', null)
if (error) { console.error(error); process.exit(1) }
console.log(`weddings: ${weddings.length}`)

// Pull all interactions for venue.
const allIxs = []
for (let from = 0; ; from += 1000) {
  const { data, error: e } = await sb.from('interactions')
    .select('id, wedding_id, from_email, timestamp, signal_class, extracted_identity')
    .eq('venue_id', RIXEY)
    .range(from, from + 999)
  if (e) { console.error(e); process.exit(1) }
  if (!data?.length) break
  allIxs.push(...data)
  if (data.length < 1000) break
}
console.log(`interactions: ${allIxs.length}`)

// Pull people emails.
const allPpl = []
for (let from = 0; ; from += 1000) {
  const { data, error: e } = await sb.from('people')
    .select('wedding_id, email')
    .eq('venue_id', RIXEY)
    .range(from, from + 999)
  if (e) { console.error(e); process.exit(1) }
  if (!data?.length) break
  allPpl.push(...data)
  if (data.length < 1000) break
}
console.log(`people: ${allPpl.length}`)

// Pull tangential signals + candidates.
const allTs = []
for (let from = 0; ; from += 1000) {
  const { data, error: e } = await sb.from('tangential_signals')
    .select('id, candidate_identity_id, source_platform, signal_date, signal_class')
    .eq('venue_id', RIXEY)
    .range(from, from + 999)
  if (e) { console.error(e); process.exit(1) }
  if (!data?.length) break
  allTs.push(...data)
  if (data.length < 1000) break
}
console.log(`tangentials: ${allTs.length}`)

const { data: cands } = await sb.from('candidate_identities')
  .select('id, resolved_wedding_id')
  .eq('venue_id', RIXEY)
  .is('deleted_at', null)
  .not('resolved_wedding_id', 'is', null)
console.log(`resolved candidates: ${cands?.length ?? 0}`)

// Pull merged-loser weddings.
const { data: losers } = await sb.from('weddings')
  .select('id, merged_into_id')
  .eq('venue_id', RIXEY)
  .not('merged_into_id', 'is', null)

// Index.
const peopleByWid = new Map()
for (const p of allPpl) {
  const e = (p.email || '').toLowerCase().trim()
  if (!e || !e.includes('@')) continue
  if (!peopleByWid.has(p.wedding_id)) peopleByWid.set(p.wedding_id, new Set())
  peopleByWid.get(p.wedding_id).add(e)
}
const ixByWid = new Map()
const ixByEmail = new Map()
for (const ix of allIxs) {
  if (ix.wedding_id) {
    if (!ixByWid.has(ix.wedding_id)) ixByWid.set(ix.wedding_id, [])
    ixByWid.get(ix.wedding_id).push(ix)
  }
  const fe = (ix.from_email || '').toLowerCase().trim()
  if (fe) {
    if (!ixByEmail.has(fe)) ixByEmail.set(fe, [])
    ixByEmail.get(fe).push(ix)
  }
}
const tsByCid = new Map()
for (const t of allTs) {
  if (!t.candidate_identity_id) continue
  if (!tsByCid.has(t.candidate_identity_id)) tsByCid.set(t.candidate_identity_id, [])
  tsByCid.get(t.candidate_identity_id).push(t)
}
const candsByWinner = new Map()
for (const c of cands || []) {
  if (!c.resolved_wedding_id) continue
  if (!candsByWinner.has(c.resolved_wedding_id)) candsByWinner.set(c.resolved_wedding_id, [])
  candsByWinner.get(c.resolved_wedding_id).push(c.id)
}
const losersByWinner = new Map()
for (const l of losers || []) {
  if (!losersByWinner.has(l.merged_into_id)) losersByWinner.set(l.merged_into_id, [])
  losersByWinner.get(l.merged_into_id).push(l.id)
}

// Per-wedding cluster compute.
const computedAt = new Date().toISOString()
const parityRows = []
let agreed = 0, disagreed = 0, bothNull = 0

for (const w of weddings) {
  const wid = w.id
  const widSet = new Set([wid, ...(losersByWinner.get(wid) || [])])
  const emails = new Set()
  for (const x of widSet) for (const e of (peopleByWid.get(x) || [])) emails.add(e)
  const candIds = candsByWinner.get(wid) || []
  const ap = w.attribution_priority?.priority?.[0]

  let clusterSource = null
  if (ap) {
    clusterSource = ap
  } else {
    const all = []
    const seen = new Set()
    for (const x of widSet) for (const ix of (ixByWid.get(x) || [])) {
      if (seen.has(ix.id)) continue
      seen.add(ix.id)
      all.push(ix)
    }
    for (const e of emails) for (const ix of (ixByEmail.get(e) || [])) {
      if (seen.has(ix.id)) continue
      seen.add(ix.id)
      all.push(ix)
    }
    // Classify each interaction.
    const sources = []
    for (const ix of all) {
      // Prefer column when source-class declared.
      if (ix.signal_class === 'source') {
        // Try to extract value.
        const ei = ix.extracted_identity || {}
        const hs = ei.hear_source || ei.hearSource || ei.where_did_you_hear
        if (hs) {
          const n = normHearSource(hs)
          if (n) { sources.push({ ts: ix.timestamp || '', value: n }); continue }
        }
        const utm = ei.utm_source || ei.utm_campaign
        if (utm) {
          const n = normHearSource(utm) || String(utm).toLowerCase()
          if (n && n !== 'honeybook') { sources.push({ ts: ix.timestamp || '', value: n }); continue }
        }
        const dom = ((ix.from_email || '').toLowerCase().split('@').pop() || '')
        if (PLATFORM_DOMAIN[dom]) { sources.push({ ts: ix.timestamp || '', value: PLATFORM_DOMAIN[dom] }); continue }
        for (const [k, v] of Object.entries(PLATFORM_DOMAIN)) {
          if (dom.endsWith('.' + k)) { sources.push({ ts: ix.timestamp || '', value: v }); break }
        }
      }
    }
    // tangentials.
    for (const cid of candIds) {
      for (const t of (tsByCid.get(cid) || [])) {
        if (t.signal_class !== 'source') continue
        const v = canonicalisePlatform(t.source_platform || '')
        if (v) sources.push({ ts: t.signal_date || '', value: v })
      }
    }
    sources.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
    clusterSource = sources[0]?.value ?? null
  }

  const chainSource = w.lead_source ?? null
  const chainLabel = chainSource ? formatLabel(chainSource) : null
  const clusterLabel = clusterSource ? formatLabel(clusterSource) : null
  const agree = chainLabel === clusterLabel
  if (chainSource === null && clusterSource === null) bothNull++
  else if (agree) agreed++
  else disagreed++

  parityRows.push({
    venue_id: RIXEY,
    wedding_id: wid,
    chain_source: chainSource,
    cluster_source: clusterSource,
    agree,
    detail: {
      chain_label: chainLabel,
      cluster_label: clusterLabel,
    },
    computed_at: computedAt,
  })
}

console.log(`\n=== Cluster compute (${weddings.length} weddings) ===`)
console.log(`  agreed:    ${agreed}`)
console.log(`  bothNull:  ${bothNull}`)
console.log(`  disagreed: ${disagreed}`)
const agreementPct = Math.round(100 * (agreed + bothNull) / weddings.length)
console.log(`  agreement: ${agreementPct}%`)

console.log('\n=== Inserting parity rows ===')
const CHUNK = 500
let inserted = 0
for (let i = 0; i < parityRows.length; i += CHUNK) {
  const chunk = parityRows.slice(i, i + CHUNK)
  const { error: ie } = await sb.from('attribution_parity_log').insert(chunk)
  if (ie) {
    console.error(`  insert chunk ${i}: ${ie.message}`)
    break
  }
  inserted += chunk.length
}
console.log(`  inserted: ${inserted} rows`)
console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
