// Schedule: Every 5 minutes (*/5 * * * *)
// Polls Gmail for new emails for each venue with connected Gmail tokens.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface VenueResult {
  venueId: string
  venueName: string
  success: boolean
  error?: string
}

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

  // Create Supabase client
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Get all venues with Gmail tokens
  const { data: venues, error: queryError } = await supabase
    .from('venues')
    .select('id, name')
    .not('gmail_tokens', 'is', null)

  if (queryError) {
    return Response.json({ error: 'Failed to query venues', detail: queryError.message }, { status: 500 })
  }

  if (!venues || venues.length === 0) {
    return Response.json({ message: 'No venues with Gmail tokens found', processed: 0 })
  }

  // Process each venue
  const results: VenueResult[] = []

  for (const venue of venues) {
    try {
      const response = await fetch(`${appUrl}/api/cron?job=email_poll&venueId=${venue.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('CRON_SECRET')}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const body = await response.text()
        results.push({
          venueId: venue.id,
          venueName: venue.name,
          success: false,
          error: `HTTP ${response.status}: ${body}`,
        })
      } else {
        results.push({
          venueId: venue.id,
          venueName: venue.name,
          success: true,
        })
      }
    } catch (err) {
      results.push({
        venueId: venue.id,
        venueName: venue.name,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const succeeded = results.filter((r) => r.success).length
  const failed = results.filter((r) => !r.success).length

  return Response.json({
    job: 'email_poll',
    timestamp: new Date().toISOString(),
    total: venues.length,
    succeeded,
    failed,
    results,
  })
})
