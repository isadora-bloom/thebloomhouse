import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, notFound, serverError } from '@/lib/api/auth-helpers'
import { logActivity } from '@/lib/services/activity-logger'

/**
 * PUT /api/couple/guest-tag-assignments?guestId=<uuid>   body: { tagIds: string[] }
 *
 * Which tags are on one guest. The only couple write that cannot go through
 * /api/couple/[resource], because guest_tag_assignments carries neither a
 * venue_id nor a wedding_id: it is scoped through the guest it points at. An id
 * on its own would be no proof of ownership, so the guest is checked first and
 * everything else hangs off that.
 *
 * The page did this as delete-all-then-insert from the browser, in two
 * statements. If the second failed the guest came back with no tags at all and
 * nothing said so. Here it is one request, the guest is verified before
 * anything is removed, and the whole thing is one line in the feed rather than
 * one per tag.
 */
export async function PUT(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  const guestId = new URL(request.url).searchParams.get('guestId')
  if (!guestId) return badRequest('guestId is required')

  try {
    const body = (await request.json().catch(() => ({}))) as { tagIds?: unknown }
    const tagIds = Array.isArray(body.tagIds) ? body.tagIds.filter((t): t is string => typeof t === 'string') : null
    if (!tagIds) return badRequest('tagIds must be an array')

    const supabase = createServiceClient()

    // The guest has to be theirs. This is the whole tenancy check for the
    // assignments, since the rows themselves carry no scope.
    const { data: guest, error: guestErr } = await supabase
      .from('guest_list')
      .select('id, first_name, last_name')
      .eq('id', guestId)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .maybeSingle()
    if (guestErr) throw guestErr
    if (!guest) return notFound('That guest is not on your list')

    // And so do the tags, or a couple could pin another wedding's tag onto
    // their own guest and see its name.
    if (tagIds.length) {
      const { data: ownTags, error: tagErr } = await supabase
        .from('guest_tags')
        .select('id')
        .in('id', tagIds)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
      if (tagErr) throw tagErr
      if ((ownTags ?? []).length !== tagIds.length) return badRequest('One of those tags is not yours')
    }

    const { error: clearErr } = await supabase
      .from('guest_tag_assignments')
      .delete()
      .eq('guest_id', guestId)
    if (clearErr) throw clearErr

    if (tagIds.length) {
      const { error: insertErr } = await supabase
        .from('guest_tag_assignments')
        .insert(tagIds.map((tag_id) => ({ guest_id: guestId, tag_id })))
      if (insertErr) throw insertErr
    }

    const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ').trim()
    logActivity({
      venueId: auth.venueId,
      weddingId: auth.weddingId,
      userId: auth.userId,
      activityType: 'guest_tags_assigned',
      entityType: 'guest_tag_assignments',
      entityId: guestId,
      details: {
        // Constant wording, like the rest of the guest list: tagging a hundred
        // guests in an evening should leave one line behind, not a hundred.
        summary: 'changed which tags are on a guest',
        guest: name || 'a guest',
        tagCount: tagIds.length,
      },
    })

    return NextResponse.json({ data: { guestId, tagIds } })
  } catch (error) {
    return serverError(error)
  }
}
