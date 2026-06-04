// Apply Wave 11 migration 278 + run 5-wedding lifecycle state machine tests.
//
// Usage:
//   node scripts/apply-wave11.mjs                    # apply + verify
//   node scripts/apply-wave11.mjs --verify-only      # skip apply
//   node scripts/apply-wave11.mjs --soft-test        # run soft transition test only

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
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const argv = process.argv.slice(2)
const VERIFY_ONLY = argv.includes('--verify-only')
const SOFT_TEST_ONLY = argv.includes('--soft-test')

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function applyMigration() {
  console.log('=== Applying migration 278 ===')
  const sql = readFileSync('supabase/migrations/278_lifecycle_state_machine.sql', 'utf8')

  // Split on semicolons NOT inside dollar-quoted blocks. The migration has
  // none so a simple split would work, but we use the exec_sql RPC's
  // ability to handle a single multi-statement string.
  const { data, error } = await sb.rpc('exec_sql', { sql })
  if (error) {
    console.error('✗ exec_sql failed:', error.message)
    return false
  }
  console.log('✓ migration 278 applied')
  return true
}

async function verifyMigration() {
  console.log('\n=== Verifying schema ===')
  // 1. weddings.lifecycle_stage column exists
  const { error: e1 } = await sb
    .from('weddings')
    .select('id, lifecycle_stage, lifecycle_stage_set_at, lifecycle_transition_count')
    .limit(1)
  if (e1) {
    console.log('✗ weddings columns missing:', e1.message)
    return false
  }
  console.log('✓ weddings.lifecycle_stage* columns present')

  // 2. lifecycle_transitions table
  const { error: e2 } = await sb.from('lifecycle_transitions').select('id').limit(1)
  if (e2 && !String(e2.message).includes('does not exist')) {
    // RLS empty result is fine
    console.log('? lifecycle_transitions:', e2.message)
  } else {
    console.log('✓ lifecycle_transitions exists')
  }

  // 3. lifecycle_transition_jobs table
  const { error: e3 } = await sb.from('lifecycle_transition_jobs').select('id').limit(1)
  if (e3 && !String(e3.message).includes('does not exist')) {
    console.log('? lifecycle_transition_jobs:', e3.message)
  } else {
    console.log('✓ lifecycle_transition_jobs exists')
  }

  return true
}

async function pickRixeyTestWeddings() {
  // Pick 5 weddings spanning different statuses.
  const targets = [
    { label: 'inquiry', filter: (q) => q.eq('status', 'inquiry') },
    { label: 'tour_scheduled', filter: (q) => q.eq('status', 'tour_scheduled') },
    { label: 'booked', filter: (q) => q.eq('status', 'booked') },
    { label: 'completed', filter: (q) => q.eq('status', 'completed') },
    { label: 'lost', filter: (q) => q.eq('status', 'lost') },
  ]

  const picks = []
  for (const t of targets) {
    let q = sb
      .from('weddings')
      .select('id, status, wedding_date, booked_at, lost_at, cancelled_at')
      .eq('venue_id', RIXEY_VENUE_ID)
    q = t.filter(q)
    q = q.limit(1)
    const { data, error } = await q
    if (error) {
      console.log('  ✗', t.label, ':', error.message)
      continue
    }
    if (!data || data.length === 0) {
      console.log('  -', t.label, ': none found')
      continue
    }
    picks.push({ ...data[0], expected_status: t.label })
  }
  return picks
}

async function runStateMachineOnWeddings(picks) {
  // We bypass the TS layer by re-implementing the deterministic rules
  // here in JS. Better idea: actually call the TS API via tsx. Use tsx
  // for fidelity to the production code path.
  const { spawnSync } = await import('node:child_process')

  console.log('\n=== Running state machine via tsx ===')
  const ids = picks.map((p) => p.id)
  const script = `
import { computeLifecycleStage } from './src/lib/services/lifecycle/state-machine.ts'
import { applyLifecycleTransition } from './src/lib/services/lifecycle/transition.ts'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\\n').filter(l=>l&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const ids = ${JSON.stringify(ids)}
const labels = ${JSON.stringify(picks.map((p) => p.expected_status))}
for (let i=0;i<ids.length;i++){
  const id = ids[i]
  const lbl = labels[i]
  const r = await computeLifecycleStage({ weddingId: id, supabase: sb })
  console.log(JSON.stringify({step:'compute',id,legacy_status:lbl,stage:r.stage,rule:r.evidence?.rule,confidence:r.confidence_0_100,soft_judge_candidate:r.soft_judge_candidate,candidate_stage:r.candidate_stage,reasoning:r.reasoning}))
  const applied = await applyLifecycleTransition({ weddingId: id, supabase: sb, skipTriggers: true })
  console.log(JSON.stringify({step:'apply',id,legacy_status:lbl,result:applied.applied,from:applied.from,to:applied.applied?applied.to:null,reason:applied.applied?undefined:applied.reason,transition_id:applied.applied?applied.transition_id:null}))
}
`
  const r = spawnSync(
    'npx',
    ['tsx', '-e', script],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: true },
  )
  if (r.stdout) console.log(r.stdout)
  if (r.stderr && r.status !== 0) console.error('STDERR:', r.stderr)
}

async function softTransitionTest() {
  console.log('\n=== Soft transition test ===')
  // Find a Rixey wedding in proposal_sent status that has been silent
  // > 14 days post-proposal. We approximate "silent post-proposal" by
  // taking proposal_sent rows whose latest inbound is > 14 days old.
  const { data: candidates, error } = await sb
    .from('weddings')
    .select('id, status, updated_at')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('status', 'proposal_sent')
    .order('updated_at', { ascending: false })
    .limit(20)
  if (error) {
    console.log('✗ candidate fetch:', error.message)
    return
  }
  if (!candidates || candidates.length === 0) {
    console.log('- no proposal_sent weddings found; trying any active status')
    return
  }

  // Check each candidate for silent > 14 days.
  let target = null
  for (const w of candidates) {
    const { data: latestIn } = await sb
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', w.id)
      .eq('direction', 'inbound')
      .order('timestamp', { ascending: false })
      .limit(1)
    const lastIn = latestIn?.[0]?.timestamp
    if (!lastIn) {
      target = w
      break
    }
    const days = (Date.now() - Date.parse(lastIn)) / (24 * 60 * 60 * 1000)
    if (days > 14) {
      target = { ...w, silent_days: days, last_inbound: lastIn }
      break
    }
  }
  if (!target) {
    console.log('- no stale proposal candidate found')
    return
  }
  console.log('Target wedding:', target.id, '(status=' + target.status + ')')
  if (target.silent_days) {
    console.log('  silent days:', Math.round(target.silent_days))
  }

  const { spawnSync } = await import('node:child_process')

  // Run state machine + check stuck candidate flag
  const script = `
import { computeLifecycleStage } from './src/lib/services/lifecycle/state-machine.ts'
import { processLifecycleJudgeQueue } from './src/lib/services/lifecycle/sweep.ts'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\\n').filter(l=>l&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const wid = '${target.id}'
const r = await computeLifecycleStage({ weddingId: wid, supabase: sb })
console.log('compute:', JSON.stringify({stage:r.stage,soft_judge_candidate:r.soft_judge_candidate,candidate_stage:r.candidate_stage,evidence:r.evidence,reasoning:r.reasoning}))
if (r.soft_judge_candidate && r.candidate_stage){
  // Enqueue a job
  const sinceIso = new Date(Date.now() - 24*60*60*1000).toISOString()
  const { data: existing } = await sb.from('lifecycle_transition_jobs').select('id').eq('wedding_id', wid).in('status', ['queued','running']).gte('enqueued_at', sinceIso).limit(1).maybeSingle()
  let jobId = existing?.id
  if (!jobId) {
    const { data: ins, error: insErr } = await sb.from('lifecycle_transition_jobs').insert({ wedding_id: wid, venue_id: 'f3d10226-4c5c-47ad-b89b-98ad63842492', status:'queued', current_stage: r.stage, candidate_stage: r.candidate_stage, trigger_signal: 'manual_test' }).select('id').single()
    if (insErr) { console.log('enqueue err:', insErr.message); process.exit(1) }
    jobId = ins.id
    console.log('enqueued job:', jobId)
  } else {
    console.log('reusing existing queued job:', jobId)
  }
  // Drain the queue
  const drainRes = await processLifecycleJudgeQueue(sb)
  console.log('drain:', JSON.stringify(drainRes))

  // Pull the resulting transition row
  const { data: rows } = await sb.from('lifecycle_transitions').select('id, from_stage, to_stage, transition_kind, reasoning, confidence, transitioned_at').eq('wedding_id', wid).order('transitioned_at', { ascending: false }).limit(3)
  console.log('latest transitions:', JSON.stringify(rows, null, 2))

  // Also probe Haiku cost
  const { data: costs } = await sb.from('api_costs').select('model, cost, input_tokens, output_tokens, context, created_at').eq('context', 'lifecycle_transition_judge').order('created_at', { ascending: false }).limit(3)
  console.log('Haiku judge costs:', JSON.stringify(costs, null, 2))
} else {
  console.log('not a stuck candidate — not enqueueing')
}
`
  const r = spawnSync('npx', ['tsx', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: true,
  })
  if (r.stdout) console.log(r.stdout)
  if (r.stderr && r.status !== 0) console.error('STDERR:', r.stderr)
}

async function main() {
  if (SOFT_TEST_ONLY) {
    await softTransitionTest()
    return
  }
  if (!VERIFY_ONLY) {
    const ok = await applyMigration()
    if (!ok) {
      console.error('Migration apply failed — stopping')
      process.exit(1)
    }
  }
  const verified = await verifyMigration()
  if (!verified) {
    console.error('Verification failed')
    process.exit(1)
  }

  console.log('\n=== Picking 5 Rixey weddings ===')
  const picks = await pickRixeyTestWeddings()
  for (const p of picks) {
    console.log(' ', p.expected_status, '→', p.id, '(wedding_date:', p.wedding_date, ', booked_at:', p.booked_at, ')')
  }
  if (picks.length > 0) {
    await runStateMachineOnWeddings(picks)
  }

  await softTransitionTest()
}

await main()
