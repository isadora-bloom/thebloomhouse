// Schedule: Daily at 7:00 AM ET (0 7 * * *)
// Sends the morning digest email summarizing overnight activity.

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
    const response = await fetch(`${appUrl}/api/cron?job=daily_digest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('CRON_SECRET')}`,
        'Content-Type': 'application/json',
      },
    })

    const body = await response.text()

    if (!response.ok) {
      return Response.json({
        job: 'daily_digest',
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
      job: 'daily_digest',
      timestamp: new Date().toISOString(),
      success: true,
      result,
    })
  } catch (err) {
    return Response.json({
      job: 'daily_digest',
      timestamp: new Date().toISOString(),
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
})
