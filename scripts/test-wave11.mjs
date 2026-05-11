// Quick test runner for Wave 11 state machine. Calls the TS code via
// dynamic import (Node.js w/ tsx loader) so we get the real production
// path, not a JS reimplementation.

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

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Test weddings (chosen from previous run)
const TEST_WEDDINGS = [
  { id: 'ef2798ab-6e0f-40ac-acf9-45f47bb0f4f8', expected: 'inquiry' },
  { id: 'cd127168-47a8-4fac-9c78-ec9252f070cb', expected: 'tour_scheduled' },
  { id: '163d7c4c-d04b-4ab9-8301-deb6cbe15347', expected: 'booked' },
  { id: '492e5722-b828-4ace-a487-0600ac0da962', expected: 'completed' },
  { id: 'c9ff7e14-0b09-40bb-9c37-5a6d6c4f8e49', expected: 'lost' },
]

const { computeLifecycleStage } = await import('../src/lib/services/lifecycle/state-machine.ts')
const { applyLifecycleTransition } = await import('../src/lib/services/lifecycle/transition.ts')

console.log('=== Wave 11: 5-wedding test ===\n')

for (const t of TEST_WEDDINGS) {
  console.log('--- ', t.expected, ' :', t.id, '---')
  const r = await computeLifecycleStage({ weddingId: t.id, supabase: sb })
  console.log('  compute:')
  console.log('    stage:', r.stage)
  console.log('    rule:', r.evidence?.rule)
  console.log('    confidence:', r.confidence_0_100)
  console.log('    soft_judge_candidate:', r.soft_judge_candidate)
  if (r.candidate_stage) console.log('    candidate_stage:', r.candidate_stage)
  console.log('    reasoning:', r.reasoning)

  const applied = await applyLifecycleTransition({
    weddingId: t.id,
    supabase: sb,
    skipTriggers: true,
  })
  console.log('  apply:')
  console.log('    applied:', applied.applied)
  if (applied.applied) {
    console.log('    from:', applied.from, '→ to:', applied.to)
    console.log('    transition_id:', applied.transition_id)
  } else {
    console.log('    reason:', applied.reason)
  }
  console.log('')
}

console.log('\n=== Soft transition test ===')

// Find a stuck proposal_sent candidate
const { data: candidates } = await sb
  .from('weddings')
  .select('id, status, updated_at')
  .eq('venue_id', RIXEY)
  .eq('status', 'proposal_sent')
  .limit(20)

console.log('proposal_sent candidates:', candidates?.length ?? 0)

let target = null
if (candidates && candidates.length > 0) {
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
      target = { ...w, silent_days: null, last_inbound: null }
      break
    }
    const days = (Date.now() - Date.parse(lastIn)) / (24 * 60 * 60 * 1000)
    if (days > 14) {
      target = { ...w, silent_days: days, last_inbound: lastIn }
      break
    }
  }
}

if (!target) {
  // Fallback: any active wedding silent > 14 days.
  console.log('no proposal_sent stuck — trying any active stuck')
  const { data: anyActive } = await sb
    .from('weddings')
    .select('id, status, updated_at')
    .eq('venue_id', RIXEY)
    .not('status', 'in', '(lost,cancelled,booked,completed)')
    .limit(30)
  for (const w of anyActive ?? []) {
    const { data: latestIn } = await sb
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', w.id)
      .eq('direction', 'inbound')
      .order('timestamp', { ascending: false })
      .limit(1)
    const lastIn = latestIn?.[0]?.timestamp
    if (!lastIn) continue
    const days = (Date.now() - Date.parse(lastIn)) / (24 * 60 * 60 * 1000)
    if (days > 14) {
      target = { ...w, silent_days: days, last_inbound: lastIn }
      break
    }
  }
}

if (!target) {
  console.log('no stuck wedding found in Rixey — cannot run soft test')
} else {
  console.log('target:', target.id, '(status=' + target.status + ', silent_days=' + Math.round(target.silent_days ?? 0) + ')')

  const r = await computeLifecycleStage({ weddingId: target.id, supabase: sb })
  console.log('compute:')
  console.log('  stage:', r.stage, 'soft_judge_candidate:', r.soft_judge_candidate, 'candidate_stage:', r.candidate_stage)

  if (r.soft_judge_candidate && r.candidate_stage) {
    // Enqueue (or reuse existing).
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await sb
      .from('lifecycle_transition_jobs')
      .select('id')
      .eq('wedding_id', target.id)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (!existing) {
      const { error: insErr } = await sb.from('lifecycle_transition_jobs').insert({
        wedding_id: target.id,
        venue_id: RIXEY,
        status: 'queued',
        current_stage: r.stage,
        candidate_stage: r.candidate_stage,
        trigger_signal: 'manual_test',
      })
      if (insErr) {
        console.log('enqueue err:', insErr.message)
        process.exit(1)
      }
      console.log('enqueued fresh job')
    } else {
      console.log('reusing existing queued job:', existing.id)
    }

    const { processLifecycleJudgeQueue } = await import(
      '../src/lib/services/lifecycle/sweep.ts'
    )
    const drainRes = await processLifecycleJudgeQueue(sb)
    console.log('drain:', JSON.stringify(drainRes))

    const { data: rows } = await sb
      .from('lifecycle_transitions')
      .select('id, from_stage, to_stage, transition_kind, reasoning, confidence, transitioned_at')
      .eq('wedding_id', target.id)
      .order('transitioned_at', { ascending: false })
      .limit(3)
    console.log('latest transitions for target:')
    console.log(JSON.stringify(rows, null, 2))

    const { data: costs } = await sb
      .from('api_costs')
      .select('model, cost, input_tokens, output_tokens, context, created_at')
      .eq('context', 'lifecycle_transition_judge')
      .order('created_at', { ascending: false })
      .limit(3)
    console.log('Haiku judge costs:')
    console.log(JSON.stringify(costs, null, 2))
  } else {
    console.log('Target is not a stuck candidate — skipping enqueue')
  }
}
