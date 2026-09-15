import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, refuseDemo, requireRole, MANAGER_ROLES } from '@/lib/api/auth-helpers'
import { apiError } from '@/lib/api/api-error'

/**
 * /api/settings/integrations/calendly
 *
 * Backs the Settings -> Calendly section. Server-side because migration
 * 413 revoked the authenticated role's SELECT on venue_config's token
 * columns: the section used to read `calendly_tokens` from the browser to
 * decide whether a token was on file, and after 413 that read answered
 * 403 on every load (§31 journey, 2026-09-15). The browser only ever
 * needs the yes/no, never the token.
 *
 *   GET — { calendlyLink, hasStoredToken }
 *   PUT — { calendlyLink?: string | null, accessToken?: string }
 *         Saves the link; replaces the stored token only when a new one
 *         is supplied. Manager roles, no demo. `.select()` after the
 *         write so a 0-row update is an error, not a silent success.
 */

export async function GET() {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (!auth.venueId) return NextResponse.json({ error: 'no_venue_in_scope' }, { status: 400 })

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('venue_config')
      .select('calendly_link, calendly_tokens')
      .eq('venue_id', auth.venueId)
      .maybeSingle()
    if (error) throw error

    const tokens = data?.calendly_tokens as { access_token?: string } | null | undefined
    return NextResponse.json({
      calendlyLink: (data?.calendly_link as string | null) ?? '',
      hasStoredToken: !!tokens?.access_token,
    })
  } catch (err) {
    return apiError(err)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (!auth.venueId) return NextResponse.json({ error: 'no_venue_in_scope' }, { status: 400 })
    const refused = refuseDemo(auth) ?? requireRole(auth, MANAGER_ROLES)
    if (refused) return refused

    const body = (await req.json().catch(() => ({}))) as {
      calendlyLink?: string | null
      accessToken?: string
    }

    const update: Record<string, unknown> = {
      calendly_link: typeof body.calendlyLink === 'string' && body.calendlyLink.trim()
        ? body.calendlyLink.trim()
        : null,
      updated_at: new Date().toISOString(),
    }
    const token = typeof body.accessToken === 'string' ? body.accessToken.trim() : ''
    if (token) update.calendly_tokens = { access_token: token }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('venue_config')
      .update(update)
      .eq('venue_id', auth.venueId)
      .select('venue_id')
    if (error) throw error
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'venue_config row not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, hasStoredToken: !!token })
  } catch (err) {
    return apiError(err)
  }
}
