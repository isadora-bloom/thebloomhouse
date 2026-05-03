/**
 * T5-Rixey-BBB spike — identity-cluster attribution prototype.
 *
 * Read-only. Does NOT mutate any production data. Builds a parallel
 * cluster-based first-touch computation for every active Rixey wedding,
 * then compares against the existing 7-tier `weddings.lead_source`.
 *
 * Run: npx tsx scripts/rixey-load/50-bbb-spike.ts
 *
 * Outputs counts to stdout AND writes a CSV at
 * `audits/2026-05-T4-postlaunch/bbb-spike-comparison.csv` for inspection.
 *
 * Per the spike mandate: ZERO LLM calls. Pure rule-based classification.
 * The classifier uses the same patterns the real refactor would
 * codify in the adapters.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Env loader
// ---------------------------------------------------------------------------

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
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// ---------------------------------------------------------------------------
// Source classifier — derived from the patterns codified in
// lead-source-derivation.ts, source-backtrace.ts, and the adapters.
// ---------------------------------------------------------------------------

type SignalClass = 'source' | 'touchpoint' | 'crm' | 'outcome' | 'unknown'

interface ClassifiedSignal {
  id: string
  source_table: 'interactions' | 'tours' | 'tangential_signals' | 'attribution_events' | 'weddings.source' | 'weddings.lead_source' | 'override'
  signal_class: SignalClass
  /** When signal_class='source', the canonical channel value. */
  source_value: string | null
  /** Sortable timestamp (ISO). */
  timestamp: string
  evidence: Record<string, unknown>
}

const PLATFORM_DOMAIN_MAP: Record<string, string> = {
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
  'honeybook.com': 'honeybook',          // crm class
  'calendly.com': 'calendly',            // touchpoint class
  'acuityscheduling.com': 'acuity',      // touchpoint class
}

const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'ymail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me',
])

const CRM_DOMAINS = new Set(['honeybook.com', 'dubsado.com'])
const TOUCHPOINT_DOMAINS = new Set(['calendly.com', 'acuityscheduling.com'])

function domainOf(email: string | null | undefined): string {
  if (!email) return ''
  const at = email.lastIndexOf('@')
  return at < 0 ? '' : email.slice(at + 1).toLowerCase()
}

function classifyByDomain(domain: string): { class: SignalClass; value: string | null } {
  if (!domain) return { class: 'unknown', value: null }
  if (CRM_DOMAINS.has(domain)) return { class: 'crm', value: 'honeybook' }
  if (TOUCHPOINT_DOMAINS.has(domain)) return { class: 'touchpoint', value: domain.split('.')[0] }
  if (PLATFORM_DOMAIN_MAP[domain]) return { class: 'source', value: PLATFORM_DOMAIN_MAP[domain] }
  for (const [k, v] of Object.entries(PLATFORM_DOMAIN_MAP)) {
    if (domain.endsWith('.' + k) || domain === k) {
      if (CRM_DOMAINS.has(k)) return { class: 'crm', value: v }
      if (TOUCHPOINT_DOMAINS.has(k)) return { class: 'touchpoint', value: v }
      return { class: 'source', value: v }
    }
  }
  if (CONSUMER_MAIL_DOMAINS.has(domain)) return { class: 'unknown', value: null }
  return { class: 'unknown', value: null }
}

function normaliseHearSource(answer: string): string | null {
  const a = answer.toLowerCase().trim()
  if (!a) return null
  if (/knot/.test(a)) return 'the_knot'
  if (/wedding ?wire/.test(a)) return 'wedding_wire'
  if (/zola/.test(a)) return 'zola'
  if (/here ?comes ?the ?guide/.test(a)) return 'here_comes_the_guide'
  if (/instagram|insta\b|ig\b/.test(a)) return 'instagram'
  if (/facebook|fb\b/.test(a)) return 'facebook'
  if (/tik ?tok/.test(a)) return 'tiktok'
  if (/pinterest/.test(a)) return 'pinterest'
  if (/google/.test(a)) return 'google'
  if (/referr|friend|family|word of mouth/.test(a)) return 'referral'
  if (/wedding planner|planner/.test(a)) return 'planner_referral'
  if (/drove ?by|driving|saw the sign/.test(a)) return 'drive_by'
  if (/web|website|own.*site/.test(a)) return 'website'
  return null
}

// ---------------------------------------------------------------------------
// Cluster loader
// ---------------------------------------------------------------------------

interface IdentityCluster {
  weddingId: string
  /** Wedding row + all merged-loser wedding ids. */
  weddingIds: Set<string>
  /** All emails from people rows attached to any of those weddings. */
  emails: Set<string>
  /** Candidate identity ids resolved to any of those weddings. */
  candidateIds: Set<string>
  /** Coordinator override value, if any. */
  coordinatorOverride: string | null
}

async function loadAllRixeyClusters(supabase: SupabaseClient): Promise<Map<string, IdentityCluster>> {
  console.log('[loader] loading active weddings...')
  const { data: weddings, error: wedErr } = await supabase
    .from('weddings')
    .select('id, attribution_priority, source, lead_source')
    .eq('venue_id', RIXEY)
    .is('merged_into_id', null)
  if (wedErr) throw new Error(`weddings load: ${wedErr.message}`)

  const clusterByWeddingId = new Map<string, IdentityCluster>()
  for (const w of weddings ?? []) {
    const ap = (w.attribution_priority as { priority?: string[] } | null) ?? null
    const override = ap?.priority && Array.isArray(ap.priority) && ap.priority.length > 0 ? ap.priority[0] : null
    clusterByWeddingId.set(w.id as string, {
      weddingId: w.id as string,
      weddingIds: new Set([w.id as string]),
      emails: new Set(),
      candidateIds: new Set(),
      coordinatorOverride: override,
    })
  }

  // Pull merged-loser weddings (so cluster's emails include theirs).
  console.log('[loader] loading merged-loser weddings...')
  const { data: losers, error: loserErr } = await supabase
    .from('weddings')
    .select('id, merged_into_id')
    .eq('venue_id', RIXEY)
    .not('merged_into_id', 'is', null)
  if (loserErr) throw new Error(`losers load: ${loserErr.message}`)
  for (const l of losers ?? []) {
    const winnerCluster = clusterByWeddingId.get(l.merged_into_id as string)
    if (winnerCluster) winnerCluster.weddingIds.add(l.id as string)
  }

  // Pull all people rows for any wedding in the cluster.
  console.log('[loader] loading people emails...')
  const allWeddingIds = Array.from(clusterByWeddingId.values()).flatMap((c) => Array.from(c.weddingIds))
  // chunk to avoid IN-list overflow
  const peopleByWedding = new Map<string, string[]>()
  const chunkSize = 200
  for (let i = 0; i < allWeddingIds.length; i += chunkSize) {
    const chunk = allWeddingIds.slice(i, i + chunkSize)
    type PplRow = { wedding_id: string | null; email: string | null }
    let ppl: PplRow[] | null = null
    let lastErr: string | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, error } = await supabase
          .from('people')
          .select('wedding_id, email')
          .in('wedding_id', chunk)
        if (error) { lastErr = error.message; await new Promise((r) => setTimeout(r, 500)); continue }
        ppl = (data ?? []) as unknown as PplRow[]
        break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        await new Promise((r) => setTimeout(r, 500 + attempt * 500))
      }
    }
    if (!ppl) throw new Error(`people load failed after retries: ${lastErr}`)
    for (const p of ppl) {
      const e = ((p.email as string | null) ?? '').toLowerCase().trim()
      if (!e || !e.includes('@')) continue
      const arr = peopleByWedding.get(p.wedding_id as string) ?? []
      arr.push(e)
      peopleByWedding.set(p.wedding_id as string, arr)
    }
  }

  for (const cluster of clusterByWeddingId.values()) {
    for (const wid of cluster.weddingIds) {
      const ems = peopleByWedding.get(wid) ?? []
      for (const e of ems) cluster.emails.add(e)
    }
  }

  // Pull candidate_identities resolved to these weddings.
  console.log('[loader] loading candidate identities...')
  for (let i = 0; i < allWeddingIds.length; i += chunkSize) {
    const chunk = allWeddingIds.slice(i, i + chunkSize)
    type CandRow = { id: string; resolved_wedding_id: string | null }
    let cands: CandRow[] | null = null
    let lastErr: string | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, error } = await supabase
          .from('candidate_identities')
          .select('id, resolved_wedding_id')
          .in('resolved_wedding_id', chunk)
          .is('deleted_at', null)
        if (error) { lastErr = error.message; await new Promise((r) => setTimeout(r, 500)); continue }
        cands = (data ?? []) as unknown as CandRow[]
        break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        await new Promise((r) => setTimeout(r, 500 + attempt * 500))
      }
    }
    if (!cands) throw new Error(`candidates load failed after retries: ${lastErr}`)
    for (const c of cands) {
      const winnerWid = c.resolved_wedding_id as string
      // Find which active cluster this loser/winner wedding belongs to.
      for (const cluster of clusterByWeddingId.values()) {
        if (cluster.weddingIds.has(winnerWid)) {
          cluster.candidateIds.add(c.id as string)
          break
        }
      }
    }
  }

  return clusterByWeddingId
}

// ---------------------------------------------------------------------------
// Signal gatherer + classifier
// ---------------------------------------------------------------------------

interface RawInteraction {
  id: string
  wedding_id: string | null
  from_email: string | null
  subject: string | null
  full_body: string | null
  type: string | null
  direction: string | null
  timestamp: string
  extracted_identity: Record<string, unknown> | null
  crm_source: string | null
}

interface RawTangential {
  id: string
  candidate_identity_id: string | null
  source_platform: string | null
  signal_type: string | null
  signal_date: string | null
  extracted_identity: Record<string, unknown> | null
}

async function gatherInteractionsForCluster(
  supabase: SupabaseClient,
  clusters: Map<string, IdentityCluster>,
): Promise<Map<string, RawInteraction[]>> {
  // Pull all Rixey interactions ONCE; index by wedding_id and by from_email
  // so we can attach to clusters.
  console.log('[gather] pulling all interactions for venue...')
  const all: RawInteraction[] = []
  let from = 0
  const pageSize = 500
  for (;;) {
    let data: RawInteraction[] | null = null
    let lastErr: string | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await supabase
          .from('interactions')
          .select('id, wedding_id, from_email, subject, full_body, type, direction, timestamp, extracted_identity, crm_source')
          .eq('venue_id', RIXEY)
          .order('timestamp', { ascending: true })
          .range(from, from + pageSize - 1)
        if (r.error) { lastErr = r.error.message; await new Promise((r) => setTimeout(r, 500)); continue }
        data = r.data as RawInteraction[]
        break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        await new Promise((r) => setTimeout(r, 500 + attempt * 500))
      }
    }
    if (!data) throw new Error(`interactions load failed: ${lastErr}`)
    if (data.length === 0) break
    all.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  console.log(`[gather]   ${all.length} interactions loaded`)

  // Build cluster-keyed map.
  const byCluster = new Map<string, RawInteraction[]>()
  for (const cluster of clusters.values()) byCluster.set(cluster.weddingId, [])

  // Index interactions by wedding_id and by from_email.
  const byWedding = new Map<string, RawInteraction[]>()
  const byFromEmail = new Map<string, RawInteraction[]>()
  for (const ix of all) {
    if (ix.wedding_id) {
      const arr = byWedding.get(ix.wedding_id) ?? []
      arr.push(ix)
      byWedding.set(ix.wedding_id, arr)
    }
    const fromE = (ix.from_email ?? '').toLowerCase().trim()
    if (fromE) {
      const arr = byFromEmail.get(fromE) ?? []
      arr.push(ix)
      byFromEmail.set(fromE, arr)
    }
  }

  for (const cluster of clusters.values()) {
    const seen = new Set<string>()
    const out: RawInteraction[] = []
    // (a) Interactions explicitly attached to any wedding in the cluster.
    for (const wid of cluster.weddingIds) {
      for (const ix of byWedding.get(wid) ?? []) {
        if (seen.has(ix.id)) continue
        seen.add(ix.id)
        out.push(ix)
      }
    }
    // (b) Interactions whose from_email matches any cluster email
    // (catches inquiries that were never linked to a wedding row).
    for (const e of cluster.emails) {
      for (const ix of byFromEmail.get(e) ?? []) {
        if (seen.has(ix.id)) continue
        seen.add(ix.id)
        out.push(ix)
      }
    }
    byCluster.set(cluster.weddingId, out)
  }
  return byCluster
}

async function gatherTangentialForCluster(
  supabase: SupabaseClient,
  clusters: Map<string, IdentityCluster>,
): Promise<Map<string, RawTangential[]>> {
  console.log('[gather] pulling all tangential signals for venue...')
  const all: RawTangential[] = []
  let from = 0
  const pageSize = 500
  for (;;) {
    let data: RawTangential[] | null = null
    let lastErr: string | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await supabase
          .from('tangential_signals')
          .select('id, candidate_identity_id, source_platform, signal_type, signal_date, extracted_identity')
          .eq('venue_id', RIXEY)
          .range(from, from + pageSize - 1)
        if (r.error) { lastErr = r.error.message; await new Promise((r) => setTimeout(r, 500)); continue }
        data = r.data as RawTangential[]
        break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        await new Promise((r) => setTimeout(r, 500 + attempt * 500))
      }
    }
    if (!data) throw new Error(`tangential load failed: ${lastErr}`)
    if (data.length === 0) break
    all.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  console.log(`[gather]   ${all.length} tangential signals loaded`)

  // Index by candidate_identity_id.
  const byCandidate = new Map<string, RawTangential[]>()
  for (const ts of all) {
    if (!ts.candidate_identity_id) continue
    const arr = byCandidate.get(ts.candidate_identity_id) ?? []
    arr.push(ts)
    byCandidate.set(ts.candidate_identity_id, arr)
  }

  const byCluster = new Map<string, RawTangential[]>()
  for (const cluster of clusters.values()) {
    const out: RawTangential[] = []
    for (const cid of cluster.candidateIds) {
      for (const ts of byCandidate.get(cid) ?? []) {
        out.push(ts)
      }
    }
    byCluster.set(cluster.weddingId, out)
  }
  return byCluster
}

// ---------------------------------------------------------------------------
// Per-cluster classifier
// ---------------------------------------------------------------------------

function classifyInteraction(ix: RawInteraction): ClassifiedSignal[] {
  const out: ClassifiedSignal[] = []

  // Q7 / hear_source extracted_identity → source signal.
  const ei = ix.extracted_identity as Record<string, unknown> | null
  if (ei && typeof ei === 'object') {
    const hs = (ei.hear_source ?? ei.hearSource ?? ei.where_did_you_hear) as string | undefined
    if (hs && typeof hs === 'string') {
      const norm = normaliseHearSource(hs)
      if (norm) {
        out.push({
          id: `${ix.id}#hear`,
          source_table: 'interactions',
          signal_class: 'source',
          source_value: norm,
          timestamp: ix.timestamp,
          evidence: { interaction_id: ix.id, hear_source: hs },
        })
      }
    }
    const utm = (ei.utm_source ?? ei.utm_campaign) as string | undefined
    if (utm && typeof utm === 'string') {
      const norm = normaliseHearSource(utm) ?? utm.toLowerCase()
      if (norm && norm !== 'honeybook') {
        out.push({
          id: `${ix.id}#utm`,
          source_table: 'interactions',
          signal_class: 'source',
          source_value: norm,
          timestamp: ix.timestamp,
          evidence: { interaction_id: ix.id, utm },
        })
      }
    }
  }

  // From-domain classification.
  if (ix.direction === 'inbound') {
    const dom = domainOf(ix.from_email)
    const cls = classifyByDomain(dom)
    if (cls.class === 'source' && cls.value) {
      out.push({
        id: `${ix.id}#fromdomain`,
        source_table: 'interactions',
        signal_class: 'source',
        source_value: cls.value,
        timestamp: ix.timestamp,
        evidence: { interaction_id: ix.id, from_domain: dom },
      })
    } else if (cls.class === 'touchpoint' && cls.value) {
      out.push({
        id: `${ix.id}#fromdomain`,
        source_table: 'interactions',
        signal_class: 'touchpoint',
        source_value: cls.value,
        timestamp: ix.timestamp,
        evidence: { interaction_id: ix.id, from_domain: dom },
      })
    } else if (cls.class === 'crm' && cls.value) {
      out.push({
        id: `${ix.id}#fromdomain`,
        source_table: 'interactions',
        signal_class: 'crm',
        source_value: cls.value,
        timestamp: ix.timestamp,
        evidence: { interaction_id: ix.id, from_domain: dom },
      })
    }
  }

  // Web-form / calculator interactions → touchpoint.
  if (ix.type === 'web_form' || ix.type === 'form') {
    out.push({
      id: `${ix.id}#webform`,
      source_table: 'interactions',
      signal_class: 'touchpoint',
      source_value: 'website',
      timestamp: ix.timestamp,
      evidence: { interaction_id: ix.id, type: ix.type },
    })
  }
  if ((ix.subject ?? '').toLowerCase().includes('calculator')) {
    out.push({
      id: `${ix.id}#calc`,
      source_table: 'interactions',
      signal_class: 'touchpoint',
      source_value: 'website',
      timestamp: ix.timestamp,
      evidence: { interaction_id: ix.id, subject: ix.subject },
    })
  }

  return out
}

function classifyTangential(ts: RawTangential): ClassifiedSignal[] {
  // tangential_signals are by definition source-class — they're cross-
  // platform engagement (Knot view, IG follow, Pinterest pin, review).
  if (!ts.source_platform) return []
  const ts_ts = ts.signal_date ?? ''
  if (!ts_ts) return []
  // Map the platform key to the canonical channel key.
  let value: string
  const sp = ts.source_platform.toLowerCase()
  if (sp.includes('knot')) value = 'the_knot'
  else if (sp.includes('weddingwire') || sp.includes('wedding_wire')) value = 'wedding_wire'
  else if (sp.includes('zola')) value = 'zola'
  else if (sp.includes('instagram')) value = 'instagram'
  else if (sp.includes('facebook')) value = 'facebook'
  else if (sp.includes('pinterest')) value = 'pinterest'
  else if (sp.includes('google')) value = 'google'
  else if (sp.includes('here_comes_the_guide') || sp.includes('hctg')) value = 'here_comes_the_guide'
  else value = sp
  return [{
    id: `ts:${ts.id}`,
    source_table: 'tangential_signals',
    signal_class: 'source',
    source_value: value,
    timestamp: ts_ts,
    evidence: { tangential_signal_id: ts.id, source_platform: ts.source_platform, signal_type: ts.signal_type },
  }]
}

interface ClusterAttribution {
  weddingId: string
  /** Cluster-derived first-touch source (or null). */
  clusterSource: string | null
  /** Earliest source-class signal timestamp. */
  clusterEarliestTs: string | null
  /** Total source-class signals seen in cluster. */
  clusterSourceSignals: number
  /** Total signals seen in cluster (any class). */
  clusterAllSignals: number
  /** Whether there was a coordinator override that won. */
  overrideUsed: boolean
}

function computeClusterAttribution(
  cluster: IdentityCluster,
  interactions: RawInteraction[],
  tangentials: RawTangential[],
): ClusterAttribution {
  if (cluster.coordinatorOverride) {
    return {
      weddingId: cluster.weddingId,
      clusterSource: cluster.coordinatorOverride,
      clusterEarliestTs: null,
      clusterSourceSignals: 0,
      clusterAllSignals: 0,
      overrideUsed: true,
    }
  }
  const allClassified: ClassifiedSignal[] = []
  for (const ix of interactions) allClassified.push(...classifyInteraction(ix))
  for (const ts of tangentials) allClassified.push(...classifyTangential(ts))

  const sources = allClassified
    .filter((s) => s.signal_class === 'source' && s.source_value)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  return {
    weddingId: cluster.weddingId,
    clusterSource: sources[0]?.source_value ?? null,
    clusterEarliestTs: sources[0]?.timestamp ?? null,
    clusterSourceSignals: sources.length,
    clusterAllSignals: allClassified.length,
    overrideUsed: false,
  }
}

// ---------------------------------------------------------------------------
// Comparison + report
// ---------------------------------------------------------------------------

interface Comparison {
  weddingId: string
  current: string | null
  cluster: string | null
  /**
   * - both_null: neither system attributed first-touch
   * - agree: same canonical source value
   * - cluster_finds_real_source: chain returned a touchpoint/crm/legacy bucket
   *   (calendly/honeybook/website/web_form/generic_csv), cluster found a real
   *   acquisition channel (the_knot/google/referral/etc.)
   * - cluster_finds_better: chain returned NULL, cluster found a source
   * - chain_wins: chain found a real source, cluster found nothing
   *   (cluster gap — usually because no candidate_identity exists)
   * - disagree_specific_value: both found different REAL sources
   */
  verdict:
    | 'agree'
    | 'cluster_finds_real_source'
    | 'cluster_finds_better'
    | 'chain_wins'
    | 'disagree_specific_value'
    | 'both_null'
  clusterSourceSignals: number
  clusterAllSignals: number
  crmSource: string | null
  legacySource: string | null
  inquiryDate: string | null
}

/** Channels the current 7-tier chain reports that are NOT real
 *  acquisition channels in the proposed model. */
const NON_SOURCE_CHANNELS = new Set([
  'calendly', 'honeybook', 'website', 'web_form', 'generic_csv',
  'dubsado', 'aisle_planner', 'tour_scheduler', 'venue_calculator',
])

async function main() {
  console.log('=== T5-Rixey-BBB spike: identity-cluster attribution prototype ===\n')
  const t0 = Date.now()

  // 1. Load all clusters.
  const clusters = await loadAllRixeyClusters(sb)
  console.log(`[step 1] ${clusters.size} active clusters loaded`)

  // 2. Gather all interactions + tangentials for each cluster.
  const interactionsByCluster = await gatherInteractionsForCluster(sb, clusters)
  const tangentialsByCluster = await gatherTangentialForCluster(sb, clusters)

  // Stats on the gather.
  let totalIxAttached = 0
  let totalTsAttached = 0
  for (const arr of interactionsByCluster.values()) totalIxAttached += arr.length
  for (const arr of tangentialsByCluster.values()) totalTsAttached += arr.length
  console.log(`[step 2] interactions attached to clusters: ${totalIxAttached}`)
  console.log(`[step 2] tangential signals attached to clusters: ${totalTsAttached}`)

  // 3. Compute cluster attribution per wedding.
  console.log('[step 3] computing cluster attribution...')
  const clusterResults = new Map<string, ClusterAttribution>()
  for (const cluster of clusters.values()) {
    const ca = computeClusterAttribution(
      cluster,
      interactionsByCluster.get(cluster.weddingId) ?? [],
      tangentialsByCluster.get(cluster.weddingId) ?? [],
    )
    clusterResults.set(cluster.weddingId, ca)
  }

  // 4. Compare against current weddings.lead_source.
  console.log('[step 4] comparing against current 7-tier output...')
  const { data: currentRows, error: cErr } = await sb
    .from('weddings')
    .select('id, lead_source, source, crm_source, inquiry_date')
    .eq('venue_id', RIXEY)
    .is('merged_into_id', null)
  if (cErr) throw new Error(`current load: ${cErr.message}`)

  const comparisons: Comparison[] = []
  for (const w of currentRows ?? []) {
    const wid = w.id as string
    const ca = clusterResults.get(wid)
    if (!ca) continue
    const current = (w.lead_source as string | null) ?? null
    const cluster = ca.clusterSource
    let verdict: Comparison['verdict']
    if (current === null && cluster === null) verdict = 'both_null'
    else if (current === null && cluster !== null) verdict = 'cluster_finds_better'
    else if (current !== null && cluster === null) verdict = 'chain_wins'
    else if (current === cluster) verdict = 'agree'
    else if (current && NON_SOURCE_CHANNELS.has(current) && cluster && !NON_SOURCE_CHANNELS.has(cluster)) {
      // Chain returned a touchpoint/crm/legacy bucket; cluster found a real source.
      verdict = 'cluster_finds_real_source'
    } else verdict = 'disagree_specific_value'
    comparisons.push({
      weddingId: wid,
      current,
      cluster,
      verdict,
      clusterSourceSignals: ca.clusterSourceSignals,
      clusterAllSignals: ca.clusterAllSignals,
      crmSource: (w.crm_source as string | null) ?? null,
      legacySource: (w.source as string | null) ?? null,
      inquiryDate: (w.inquiry_date as string | null) ?? null,
    })
  }

  // 5. Aggregate.
  const totals: Record<string, number> = {
    total_weddings: comparisons.length,
    cluster_attributes_first_touch: 0,
    current_attributes_first_touch: 0,
    chain_attributes_with_real_source: 0,         // current is set AND not in NON_SOURCE_CHANNELS
    chain_attributes_with_touchpoint_only: 0,     // current is in NON_SOURCE_CHANNELS
    agree: 0,
    cluster_finds_real_source: 0,                 // chain reported touchpoint/crm bucket
    cluster_finds_better: 0,                      // chain returned NULL
    chain_wins: 0,                                // cluster returned NULL
    both_null: 0,
    disagree_specific_value: 0,
  }
  for (const c of comparisons) {
    if (c.cluster) totals.cluster_attributes_first_touch++
    if (c.current) totals.current_attributes_first_touch++
    if (c.current) {
      if (NON_SOURCE_CHANNELS.has(c.current)) totals.chain_attributes_with_touchpoint_only++
      else totals.chain_attributes_with_real_source++
    }
    if (c.verdict === 'agree') totals.agree++
    if (c.verdict === 'cluster_finds_better') totals.cluster_finds_better++
    if (c.verdict === 'cluster_finds_real_source') totals.cluster_finds_real_source++
    if (c.verdict === 'chain_wins') totals.chain_wins++
    if (c.verdict === 'both_null') totals.both_null++
    if (c.verdict === 'disagree_specific_value') totals.disagree_specific_value++
  }

  // Distribution of cluster-derived values vs current.
  const distCluster: Record<string, number> = {}
  const distCurrent: Record<string, number> = {}
  for (const c of comparisons) {
    distCluster[c.cluster ?? '(null)'] = (distCluster[c.cluster ?? '(null)'] ?? 0) + 1
    distCurrent[c.current ?? '(null)'] = (distCurrent[c.current ?? '(null)'] ?? 0) + 1
  }

  // Specifically: the calculator-submission case.
  const calculatorRows = comparisons.filter((c) => c.crmSource === 'web_form')
  let calculatorWithKnotInCluster = 0
  let calculatorWithSomeSourceInCluster = 0
  for (const c of calculatorRows) {
    if (c.cluster === 'the_knot') calculatorWithKnotInCluster++
    if (c.cluster) calculatorWithSomeSourceInCluster++
  }

  // Disagreement breakdown — what specific channel-pairs do we see?
  const disagreePairs: Record<string, number> = {}
  for (const c of comparisons) {
    if (c.verdict === 'disagree_specific_value') {
      const k = `${c.current} → ${c.cluster}`
      disagreePairs[k] = (disagreePairs[k] ?? 0) + 1
    }
  }

  // Cluster_wins breakdown — which channels surface that the chain missed?
  const winsByChannel: Record<string, number> = {}
  for (const c of comparisons) {
    if ((c.verdict === 'cluster_finds_better' || c.verdict === 'cluster_finds_real_source') && c.cluster) {
      winsByChannel[c.cluster] = (winsByChannel[c.cluster] ?? 0) + 1
    }
  }
  // chain_wins breakdown — which channels does the chain find but the cluster misses?
  const chainWinsByChannel: Record<string, number> = {}
  for (const c of comparisons) {
    if (c.verdict === 'chain_wins' && c.current) {
      chainWinsByChannel[c.current] = (chainWinsByChannel[c.current] ?? 0) + 1
    }
  }

  // ----- Report -----
  console.log('\n=================== SPIKE RESULTS ===================')
  for (const [k, v] of Object.entries(totals)) {
    console.log(`  ${k.padEnd(36)} ${v}`)
  }

  console.log('\n--- cluster-derived lead_source distribution (top 15) ---')
  for (const [k, v] of Object.entries(distCluster).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }

  console.log('\n--- current 7-tier lead_source distribution (top 15) ---')
  for (const [k, v] of Object.entries(distCurrent).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }

  console.log(`\n--- Calculator-submission cohort (crm_source='web_form'): ${calculatorRows.length} weddings ---`)
  console.log(`  with the_knot in cluster:                    ${calculatorWithKnotInCluster}`)
  console.log(`  with ANY source signal in cluster:           ${calculatorWithSomeSourceInCluster}`)

  console.log('\n--- cluster_wins by channel (chain missed OR returned touchpoint) ---')
  for (const [k, v] of Object.entries(winsByChannel).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }

  console.log('\n--- chain_wins by channel (chain found, cluster missed — gaps) ---')
  for (const [k, v] of Object.entries(chainWinsByChannel).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }

  console.log('\n--- top 10 disagree_specific_value pairs (current → cluster) ---')
  for (const [k, v] of Object.entries(disagreePairs).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${k.padEnd(40)} ${v}`)
  }

  // Write CSV for offline inspection.
  const csvPath = 'audits/2026-05-T4-postlaunch/bbb-spike-comparison.csv'
  const lines = ['wedding_id,verdict,current,cluster,crm_source,legacy_source,cluster_source_signals,cluster_all_signals,inquiry_date']
  for (const c of comparisons) {
    lines.push([
      c.weddingId,
      c.verdict,
      JSON.stringify(c.current ?? ''),
      JSON.stringify(c.cluster ?? ''),
      JSON.stringify(c.crmSource ?? ''),
      JSON.stringify(c.legacySource ?? ''),
      String(c.clusterSourceSignals),
      String(c.clusterAllSignals),
      JSON.stringify(c.inquiryDate ?? ''),
    ].join(','))
  }
  writeFileSync(csvPath, lines.join('\n'), 'utf8')
  console.log(`\nWrote ${comparisons.length}-row comparison CSV to ${csvPath}`)
  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch((e) => { console.error(e); process.exit(1) })
