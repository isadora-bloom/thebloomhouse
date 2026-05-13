/**
 * Calendly outbound integration.
 *
 * Mirrors rixey-portal's `/api/calendly/events` admin tab — fetches the
 * coordinator's upcoming Calendly events plus invitee details so the
 * platform UI can show a "next 5 meetings" widget.
 *
 * Token resolution (in priority order):
 *   1. `venue_config.calendly_tokens.access_token` (per-venue OAuth or PAT)
 *   2. `process.env.CALENDLY_API_TOKEN` (single-tenant fallback)
 *
 * If `calendly_tokens` carries a `refresh_token` + `expires_at` and the
 * access token is expired (or about to be), we attempt an OAuth refresh
 * and persist the new token bundle back to venue_config. Refresh requires
 * `CALENDLY_OAUTH_CLIENT_ID` + `CALENDLY_OAUTH_CLIENT_SECRET` env vars.
 *
 * Read-only by design — we never create/cancel events from this module.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendlyTokens {
  access_token?: string
  refresh_token?: string
  /** ISO 8601 timestamp or unix-epoch seconds — both supported. */
  expires_at?: string | number
  /** Optional pre-resolved organization URI (cached). */
  organization?: string
  /** Optional pre-resolved user URI (cached). */
  user?: string
}

export interface CalendlyInvitee {
  name: string | null
  email: string | null
  status?: string | null
}

export interface CalendlyEvent {
  uuid: string
  uri: string
  name: string | null
  start_time: string
  end_time: string
  location: string | null
  status: string
  event_type: string | null
  invitees: CalendlyInvitee[]
}

export class CalendlyNotConfiguredError extends Error {
  code = 'NOT_CONFIGURED' as const
  constructor(message = 'Calendly is not configured for this venue.') {
    super(message)
    this.name = 'CalendlyNotConfiguredError'
  }
}

export class CalendlyReconnectError extends Error {
  code = 'RECONNECT_REQUIRED' as const
  constructor(message = 'Calendly access token expired and refresh failed. Reconnect required.') {
    super(message)
    this.name = 'CalendlyReconnectError'
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const CALENDLY_BASE = 'https://api.calendly.com'
const CALENDLY_TOKEN_URL = 'https://auth.calendly.com/oauth/token'

function isExpired(expiresAt: string | number | undefined): boolean {
  if (expiresAt == null) return false
  const ms =
    typeof expiresAt === 'number'
      ? // Heuristic: <1e12 means seconds since epoch
        (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt)
      : Date.parse(expiresAt)
  if (Number.isNaN(ms)) return false
  // Refresh 60s early to avoid clock skew at the boundary
  return ms - Date.now() < 60_000
}

async function refreshAccessToken(
  venueId: string,
  tokens: CalendlyTokens
): Promise<string> {
  const clientId = process.env.CALENDLY_OAUTH_CLIENT_ID
  const clientSecret = process.env.CALENDLY_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret || !tokens.refresh_token) {
    throw new CalendlyReconnectError(
      'Calendly token expired and OAuth credentials are not configured for refresh.'
    )
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  })

  const res = await fetch(CALENDLY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    throw new CalendlyReconnectError(
      `Calendly token refresh failed (${res.status}). Reconnect required.`
    )
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  const updated: CalendlyTokens = {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at:
      typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : tokens.expires_at,
  }

  // Persist new bundle back to venue_config
  const supabase = createServiceClient()
  await supabase
    .from('venue_config')
    .update({ calendly_tokens: updated, updated_at: new Date().toISOString() })
    .eq('venue_id', venueId)

  return data.access_token
}

interface ClientHandle {
  token: string
  /** Cached org/user URIs from the token bundle (if any). */
  cached: { organization?: string; user?: string }
  /** True when token came from env fallback (no per-venue OAuth refresh path). */
  fromEnv: boolean
}

export async function getCalendlyClient(venueId: string): Promise<ClientHandle> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('venue_config')
    .select('calendly_tokens')
    .eq('venue_id', venueId)
    .maybeSingle()

  const tokens = (data?.calendly_tokens ?? null) as CalendlyTokens | null

  if (tokens?.access_token) {
    let accessToken = tokens.access_token
    if (isExpired(tokens.expires_at)) {
      accessToken = await refreshAccessToken(venueId, tokens)
    }
    // Self-heal: resolve tokens.user + tokens.organization from /users/me
    // and persist back to venue_config when missing. The webhook handler's
    // path-A routing (host URI match against venue_config.calendly_tokens
    // ->>user) only works if these URIs are cached, and the settings page
    // historically only persisted access_token. This block makes the first
    // server-side touch self-healing for any venue with a token saved.
    if (!tokens.user || !tokens.organization) {
      try {
        const me = await calendlyGet<CalendlyUserMe>(accessToken, '/users/me')
        const updated: CalendlyTokens = {
          ...tokens,
          access_token: accessToken,
          user: tokens.user ?? me.resource.uri,
          organization: tokens.organization ?? me.resource.current_organization,
        }
        await supabase
          .from('venue_config')
          .update({ calendly_tokens: updated, updated_at: new Date().toISOString() })
          .eq('venue_id', venueId)
        return {
          token: accessToken,
          cached: { organization: updated.organization, user: updated.user },
          fromEnv: false,
        }
      } catch (err) {
        // Non-fatal — caller can still issue authenticated requests; the
        // missing URIs just mean webhook path-A won't route until a later
        // call succeeds. Log and fall through.
        console.warn(
          `[calendly/getCalendlyClient] /users/me self-heal failed for venue ${venueId}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    return {
      token: accessToken,
      cached: { organization: tokens.organization, user: tokens.user },
      fromEnv: false,
    }
  }

  const envToken = process.env.CALENDLY_API_TOKEN
  if (envToken) {
    return { token: envToken, cached: {}, fromEnv: true }
  }

  throw new CalendlyNotConfiguredError()
}

/**
 * Walk every venue_config with a stored Calendly access_token but
 * missing user/organization URIs, and trigger the self-heal in
 * getCalendlyClient to cache them. Idempotent — venues already cached
 * are skipped, venues with no token are skipped, venues whose
 * /users/me call fails are logged and moved on.
 *
 * Wired into prune_maintenance daily so a brand-new venue connecting
 * Calendly tomorrow has its host URI cached within 24h even if the
 * settings-page server hook misses (network blip, etc). Closes the
 * cold-start window for the Calendly webhook's path-A routing.
 *
 * Returns counts for telemetry: scanned (rows with tokens), cached
 * (rows we just resolved), already (rows that were already cached),
 * failed (rows whose /users/me call errored).
 */
export async function runCalendlyUriBackfill(): Promise<{
  scanned: number
  cached: number
  already: number
  failed: number
}> {
  const supabase = createServiceClient()
  const { data: rows, error } = await supabase
    .from('venue_config')
    .select('venue_id, calendly_tokens')
    .not('calendly_tokens', 'is', null)
    .limit(1000)
  if (error) {
    console.error('[calendly/uri-backfill] venue_config read failed:', error.message)
    return { scanned: 0, cached: 0, already: 0, failed: 0 }
  }
  const candidates = (rows ?? []).filter((row) => {
    const t = row.calendly_tokens as CalendlyTokens | null
    return !!t?.access_token && (!t.user || !t.organization)
  })
  let cached = 0
  let failed = 0
  for (const row of candidates) {
    // Serial. /users/me is fast (sub-second) and we want to avoid
    // fanning out 100 outbound HTTPS calls in parallel that could trip
    // Calendly rate limits at scale.
    try {
      const before = row.calendly_tokens as CalendlyTokens
      await getCalendlyClient(row.venue_id as string)
      // Re-read to verify the cache actually populated. getCalendlyClient's
      // self-heal swallows /users/me errors and falls through.
      const { data: after } = await supabase
        .from('venue_config')
        .select('calendly_tokens')
        .eq('venue_id', row.venue_id as string)
        .maybeSingle()
      const afterTokens = (after?.calendly_tokens ?? null) as CalendlyTokens | null
      if (afterTokens?.user && afterTokens?.organization && (!before.user || !before.organization)) {
        cached++
      } else if (!afterTokens?.user || !afterTokens?.organization) {
        failed++
      }
    } catch (err) {
      console.warn(
        `[calendly/uri-backfill] venue ${row.venue_id} backfill failed:`,
        err instanceof Error ? err.message : err,
      )
      failed++
    }
  }
  const already = (rows ?? []).filter((row) => {
    const t = row.calendly_tokens as CalendlyTokens | null
    return !!t?.access_token && !!t.user && !!t.organization
  }).length
  return { scanned: candidates.length, cached, already, failed }
}

async function calendlyGet<T>(token: string, path: string): Promise<T> {
  const url = path.startsWith('http') ? path : `${CALENDLY_BASE}${path}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    if (res.status === 401) {
      throw new CalendlyReconnectError(
        'Calendly returned 401 — the access token is invalid. Reconnect required.'
      )
    }
    const text = await res.text().catch(() => '')
    throw new Error(
      `Calendly API ${res.status} for ${path}: ${text.slice(0, 200) || res.statusText}`
    )
  }
  return res.json() as Promise<T>
}

interface CalendlyUserMe {
  resource: {
    uri: string
    current_organization: string
  }
}

interface CalendlyScheduledEvent {
  uri: string
  name: string | null
  start_time: string
  end_time: string
  status: string
  event_type?: string | null
  location?: { type?: string; location?: string | null } | null
}

interface CalendlyInviteeRaw {
  name: string | null
  email: string | null
  status?: string | null
}

// ---------------------------------------------------------------------------
// Public: fetchUpcomingEvents
// ---------------------------------------------------------------------------

export async function fetchUpcomingEvents(
  venueId: string,
  opts: { limit?: number } = {}
): Promise<CalendlyEvent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const client = await getCalendlyClient(venueId)

  // 1) Resolve user + org URIs (use cached values when present)
  let organization = client.cached.organization
  if (!organization) {
    const me = await calendlyGet<CalendlyUserMe>(client.token, '/users/me')
    organization = me.resource.current_organization
  }

  // 2) List upcoming scheduled events
  const minStart = new Date().toISOString()
  const params = new URLSearchParams({
    organization,
    min_start_time: minStart,
    status: 'active',
    sort: 'start_time:asc',
    count: String(limit),
  })

  const events = await calendlyGet<{ collection: CalendlyScheduledEvent[] }>(
    client.token,
    `/scheduled_events?${params.toString()}`
  )

  // 3) Per-event invitee lookup (parallel)
  const enriched = await Promise.all(
    events.collection.map(async (ev) => {
      const uuid = ev.uri.split('/').pop() ?? ev.uri
      let invitees: CalendlyInvitee[] = []
      try {
        const data = await calendlyGet<{ collection: CalendlyInviteeRaw[] }>(
          client.token,
          `/scheduled_events/${uuid}/invitees`
        )
        invitees = (data.collection ?? []).map((i) => ({
          name: i.name ?? null,
          email: i.email ?? null,
          status: i.status ?? null,
        }))
      } catch (err) {
        // Don't fail the whole list if a single invitee lookup glitches
        console.error(`[calendly] invitee fetch failed for ${uuid}:`, err)
      }

      const locationStr =
        (ev.location?.location ?? null) || ev.location?.type || null

      return {
        uuid,
        uri: ev.uri,
        name: ev.name,
        start_time: ev.start_time,
        end_time: ev.end_time,
        location: locationStr,
        status: ev.status,
        event_type: ev.event_type ?? null,
        invitees,
      } satisfies CalendlyEvent
    })
  )

  return enriched
}
