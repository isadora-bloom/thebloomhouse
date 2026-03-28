// Schedule: Daily at 9:00 AM ET (0 9 * * *)
// Processes follow-up email sequences, sending the next step for leads due today.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  // Verify authorization
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${Deno.env.get('CRON_SECRET')}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const appUrl = Deno.env.get('APP_URL')
  if (!appUrl) {
    return Response.json({ error: 'APP_URL not configured' }, { status: 500 })
  }

  try {
    const response = await fetch(`${appUrl}/api/cron?job=follow_up_sequences`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('CRON_SECRET')}`,
        'Content-Type': 'application/json',
      },
    })

    const body = await response.text()

    if (!response.ok) {
      return Response.json({
        job: 'follow_up_sequences',
        timestamp: new Date().toISOString(),
        success: false,
        error: `HTTP ${response.status}: ${body}`,
      }, { status: 500 })
    }

    let result
    try {
      result = JSON.parse(body)
    } catch {
      result = { raw: body }
    }

    return Response.json({
      job: 'follow_up_sequences',
      timestamp: new Date().toISOString(),
      success: true,
      result,
    })
  } catch (err) {
    return Response.json({
      job: 'follow_up_sequences',
      timestamp: new Date().toISOString(),
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
})
