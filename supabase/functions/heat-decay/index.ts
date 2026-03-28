// Schedule: Daily at midnight ET (0 0 * * *)
// Applies a 0.98 daily decay multiplier to lead heat scores for active pipeline stages.
// Updates temperature_tier based on the new score.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DECAY_MULTIPLIER = 0.98
const ACTIVE_STATUSES = ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent']

function getTemperatureTier(score: number): string {
  if (score >= 80) return 'hot'
  if (score >= 50) return 'warm'
  if (score >= 20) return 'cool'
  return 'cold'
}

Deno.serve(async (req) => {
  // Verify authorization
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${Deno.env.get('CRON_SECRET')}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Create Supabase client with service role for direct DB access
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Fetch all weddings in active pipeline stages with a heat score
  const { data: weddings, error: queryError } = await supabase
    .from('weddings')
    .select('id, heat_score, temperature_tier')
    .in('status', ACTIVE_STATUSES)
    .not('heat_score', 'is', null)
    .gt('heat_score', 0)

  if (queryError) {
    return Response.json({
      job: 'heat_decay',
      timestamp: new Date().toISOString(),
      success: false,
      error: queryError.message,
    }, { status: 500 })
  }

  if (!weddings || weddings.length === 0) {
    return Response.json({
      job: 'heat_decay',
      timestamp: new Date().toISOString(),
      success: true,
      updated: 0,
      message: 'No active weddings with heat scores to decay',
    })
  }

  let updated = 0
  let failed = 0

  for (const wedding of weddings) {
    const newScore = Math.round(wedding.heat_score * DECAY_MULTIPLIER * 100) / 100
    const newTier = getTemperatureTier(newScore)

    const { error: updateError } = await supabase
      .from('weddings')
      .update({
        heat_score: newScore,
        temperature_tier: newTier,
      })
      .eq('id', wedding.id)

    if (updateError) {
      failed++
    } else {
      updated++
    }
  }

  return Response.json({
    job: 'heat_decay',
    timestamp: new Date().toISOString(),
    success: failed === 0,
    total: weddings.length,
    updated,
    failed,
    decay_multiplier: DECAY_MULTIPLIER,
  })
})
