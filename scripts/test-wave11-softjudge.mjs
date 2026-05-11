// Wave 11 soft-judge test. Uses one of the test weddings we already
// know flagged soft_judge_candidate=true (the 'inquiry' pick that
// resolved to post_event because its event_date is in the past).

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

// Wedding from the inquiry test pick that flagged soft_judge_candidate=true.
// Event date is in the past so it's now post_event with candidate_stage = long_tail.
const target = 'ef2798ab-6e0f-40ac-acf9-45f47bb0f4f8'

const { computeLifecycleStage } = await import('../src/lib/services/lifecycle/state-machine.ts')

const r = await computeLifecycleStage({ weddingId: target, supabase: sb })
console.log('target:', target)
console.log('compute:', JSON.stringify({
  stage: r.stage,
  rule: r.evidence?.rule,
  soft_judge_candidate: r.soft_judge_candidate,
  candidate_stage: r.candidate_stage,
  reasoning: r.reasoning,
}, null, 2))

if (!r.soft_judge_candidate || !r.candidate_stage) {
  console.log('Not a stuck candidate — exiting')
  process.exit(0)
}

// Enqueue a job for this wedding (skip dedupe by clearing prior queued).
await sb
  .from('lifecycle_transition_jobs')
  .update({ status: 'skipped' })
  .eq('wedding_id', target)
  .in('status', ['queued', 'running'])

const { data: ins, error: insErr } = await sb
  .from('lifecycle_transition_jobs')
  .insert({
    wedding_id: target,
    venue_id: RIXEY,
    status: 'queued',
    current_stage: r.stage,
    candidate_stage: r.candidate_stage,
    trigger_signal: 'manual_softjudge_test',
  })
  .select('id')
  .single()
if (insErr) {
  console.log('enqueue err:', insErr.message)
  process.exit(1)
}
console.log('enqueued:', ins.id)

const { processLifecycleJudgeQueue } = await import(
  '../src/lib/services/lifecycle/sweep.ts'
)
const drainRes = await processLifecycleJudgeQueue(sb)
console.log('\ndrain result:')
console.log(JSON.stringify(drainRes, null, 2))

const { data: rows } = await sb
  .from('lifecycle_transitions')
  .select('id, from_stage, to_stage, transition_kind, reasoning, confidence, transitioned_at')
  .eq('wedding_id', target)
  .order('transitioned_at', { ascending: false })
  .limit(3)
console.log('\nlatest transitions:')
console.log(JSON.stringify(rows, null, 2))

const { data: costs } = await sb
  .from('api_costs')
  .select('model, cost, input_tokens, output_tokens, context, created_at')
  .eq('context', 'lifecycle_transition_judge')
  .order('created_at', { ascending: false })
  .limit(3)
console.log('\nHaiku judge costs (lifecycle_transition_judge):')
console.log(JSON.stringify(costs, null, 2))
