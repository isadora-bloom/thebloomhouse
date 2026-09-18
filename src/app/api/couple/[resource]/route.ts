import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getCoupleAuth,
  unauthorized,
  badRequest,
  notFound,
  serverError,
} from '@/lib/api/auth-helpers'
import { logActivity } from '@/lib/services/activity-logger'
import {
  COUPLE_RESOURCES,
  coupleActivity,
  pickFields,
  type CoupleResource,
  type CoupleAction,
} from '@/lib/api/couple-resources'

/**
 * One route for everything a couple edits.
 *
 * Every couple page wrote straight from the browser with the anon client: 126
 * write sites across 25 pages and 34 tables. RLS holds, so nothing was broken,
 * but there was no server-side moment for any of it. Nothing logged. The scope
 * of each row was whatever the browser put in the payload. When a Rixey couple
 * spent three days asking why her wedding party was missing from her website,
 * the reason it could not be answered was that saving the website left no trace
 * anywhere, and the same was true here of everything a couple touches.
 *
 * 126 hand-written handlers would be 126 chances to forget the venue check, so
 * this is one handler reading src/lib/api/couple-resources.ts. Adding a
 * resource is a line in that table.
 *
 *   POST   /api/couple/<resource>            create, or upsert for a singleton
 *   PATCH  /api/couple/<resource>?id=<uuid>  update one row
 *   DELETE /api/couple/<resource>?id=<uuid>  remove one row
 *
 * Three things every write gets, which the browser writes never had:
 *
 *   1. Scope from the session, not the payload. `venue_id` and `wedding_id`
 *      come from getCoupleAuth and a body that carries them is refused. A
 *      client naming its own wedding is a client naming its own permissions.
 *   2. A field whitelist, so a form that grows a field nobody wired up says so
 *      in a log rather than failing in Postgres's vocabulary at the couple.
 *   3. An entry in activity_log, which is the point of all of it.
 *
 * RLS is still on and still correct. It is now the second line rather than the
 * only one.
 */

function resolveResource(name: string): CoupleResource | null {
  return Object.prototype.hasOwnProperty.call(COUPLE_RESOURCES, name)
    ? COUPLE_RESOURCES[name]
    : null
}

/**
 * Log the write. Never allowed to fail the couple's save: logActivity already
 * swallows its own errors, and this is fire-and-forget on top of that.
 */
function record(
  resource: CoupleResource,
  action: CoupleAction,
  row: Record<string, unknown> | null,
  auth: { venueId: string; weddingId: string; userId: string },
  extra?: Record<string, unknown>,
) {
  const { activityType, details } = coupleActivity(resource, action, row)
  logActivity({
    venueId: auth.venueId,
    weddingId: auth.weddingId,
    userId: auth.userId,
    activityType,
    entityType: resource.table,
    entityId: typeof row?.id === 'string' ? row.id : undefined,
    details: { summary: details, ...extra },
  })
}

// ---------------------------------------------------------------------------
// POST — create a row, or save the whole form for a singleton
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ resource: string }> },
) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  const { resource: name } = await params
  const resource = resolveResource(name)
  if (!resource) return notFound('Resource')

  try {
    const body = await request.json().catch(() => ({}))
    const { fields, refused } = pickFields(resource, body)
    if (refused.length) {
      // Said out loud rather than dropped. A silently ignored field looks
      // exactly like a save that worked.
      console.warn(`[couple/${name}] refused fields: ${refused.join(', ')}`)
    }
    if (!Object.keys(fields).length) return badRequest('Nothing to save')

    const supabase = createServiceClient()
    const scope = { venue_id: auth.venueId, wedding_id: auth.weddingId }

    if (resource.singleton) {
      // One row per wedding. onConflict is the wedding, so a couple cannot
      // create a second row for themselves by saving twice.
      const { data, error } = await supabase
        .from(resource.table)
        .upsert({ ...scope, ...fields }, { onConflict: 'wedding_id' })
        .select()
        .single()
      if (error) throw error
      record(resource, 'updated', data, auth, { fields: Object.keys(fields) })
      return NextResponse.json({ data })
    }

    const { data, error } = await supabase
      .from(resource.table)
      .insert({ ...scope, ...fields })
      .select()
      .single()
    if (error) throw error
    record(resource, 'added', data, auth)
    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    return serverError(error)
  }
}

// ---------------------------------------------------------------------------
// PATCH — update one row
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ resource: string }> },
) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  const { resource: name } = await params
  const resource = resolveResource(name)
  if (!resource) return notFound('Resource')

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return badRequest('id is required')

  try {
    const body = await request.json().catch(() => ({}))
    const { fields, refused } = pickFields(resource, body)
    if (refused.length) console.warn(`[couple/${name}] refused fields: ${refused.join(', ')}`)
    if (!Object.keys(fields).length) return badRequest('Nothing to save')

    const supabase = createServiceClient()
    // The scope filters are what stop an id from another wedding being edited.
    // Belt and braces next to RLS, and the only guard if RLS is ever relaxed.
    const { data, error } = await supabase
      .from(resource.table)
      .update(fields)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .select()
      .maybeSingle()
    if (error) throw error
    // Nothing updated is not a success. Either the row is gone or it is not
    // theirs, and answering "ok" hides both.
    if (!data) return notFound('That is not on your list any more')

    record(resource, 'updated', data, auth, { fields: Object.keys(fields) })
    return NextResponse.json({ data })
  } catch (error) {
    return serverError(error)
  }
}

// ---------------------------------------------------------------------------
// DELETE — remove one row
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ resource: string }> },
) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  const { resource: name } = await params
  const resource = resolveResource(name)
  if (!resource) return notFound('Resource')

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return badRequest('id is required')

  try {
    const supabase = createServiceClient()
    // Returned so the feed entry can name what went, which is the one thing
    // you cannot recover afterwards.
    const { data, error } = await supabase
      .from(resource.table)
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .select()
      .maybeSingle()
    if (error) throw error
    if (!data) return notFound('That is not on your list any more')

    record(resource, 'removed', data, auth)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return serverError(error)
  }
}
