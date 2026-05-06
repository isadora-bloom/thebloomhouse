import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
} from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Thread Lock API
//
// POST — Acquire or refresh a thread lock (upsert into activity_log)
// GET  — Check for active locks on a thread
// DELETE — Release a thread lock
//
// Locks auto-expire after 10 minutes (stale check on read). Auth:
// coordinator. Pre-fix venueId came from the body/query, lockedBy was
// a free-text string. Any caller could read or write locks for any
// venue. We now derive venue_id from auth.venueId and lockedBy from
// auth.userId, ignoring client-supplied values for non-admins.
// Per 2026-05-06 audit Lens 1.
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 10 * 60 * 1000 // 10 minutes

export async function POST(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { interactionId, threadId } = body as {
      interactionId: string
      threadId?: string
    }

    if (!interactionId) {
      return NextResponse.json(
        { error: 'Missing interactionId' },
        { status: 400 }
      )
    }

    // Server-derived. Body venueId / lockedBy ignored — locks are
    // always taken in the authenticated user's id + venue. The display
    // name for the GET path comes from user_profiles so other
    // coordinators see "Sarah" not a UUID.
    const venueId = auth.venueId

    const supabase = createServiceClient()

    // Defensive ownership: confirm the interaction belongs to this
    // venue before stamping a lock. Stops any caller from creating
    // bogus lock entries pointing at another venue's interactions.
    // Same query also resolves the display name for the lock.
    const [
      { data: interaction },
      { data: profile },
    ] = await Promise.all([
      supabase
        .from('interactions')
        .select('venue_id')
        .eq('id', interactionId)
        .maybeSingle(),
      supabase
        .from('user_profiles')
        .select('first_name, last_name')
        .eq('id', auth.userId)
        .maybeSingle(),
    ])

    if (!interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 })
    }
    const decision = await assertCanAccessVenue(auth, interaction.venue_id as string)
    if (!decision.ok) return forbidden(`interaction ${decision.reason}`)

    const displayName = [profile?.first_name, profile?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Coordinator'

    // Insert a thread_lock activity log entry. Stores BOTH the user_id
    // (auditable, immutable) and the display name (UX-friendly).
    await supabase.from('activity_log').insert({
      venue_id: venueId,
      activity_type: 'thread_lock',
      entity_type: 'interaction',
      entity_id: interactionId,
      details: {
        locked_by_id: auth.userId,
        locked_by: displayName,
        locked_at: new Date().toISOString(),
        thread_id: threadId ?? null,
      },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[thread-lock] POST failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const { searchParams } = new URL(request.url)
    const interactionId = searchParams.get('interactionId')
    const threadId = searchParams.get('threadId')

    if (!interactionId && !threadId) {
      return NextResponse.json(
        { error: 'Missing interactionId or threadId' },
        { status: 400 }
      )
    }

    const venueId = auth.venueId
    const currentUser = auth.userId

    const supabase = createServiceClient()

    const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString()

    // Look for recent thread_lock entries
    let query = supabase
      .from('activity_log')
      .select('id, details, created_at')
      .eq('venue_id', venueId)
      .eq('activity_type', 'thread_lock')
      .eq('entity_type', 'interaction')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(5)

    if (interactionId) {
      query = query.eq('entity_id', interactionId)
    }

    const { data: locks } = await query

    // Filter out locks by the current user and find the most recent
    // from someone else. Identity match is by locked_by_id (UUID,
    // server-derived) — immutable across name changes, and impossible
    // for a client to spoof. Pre-fix locks (without locked_by_id) age
    // out within LOCK_TTL_MS so backward compatibility is automatic.
    const activeLock = (locks ?? []).find((lock) => {
      const details = lock.details as Record<string, unknown> | null
      if (!details) return false
      const lockedById = details.locked_by_id as string | undefined
      const lockedAt = details.locked_at as string | undefined

      if (lockedAt) {
        const lockTime = new Date(lockedAt).getTime()
        if (Date.now() - lockTime > LOCK_TTL_MS) return false
      }

      if (threadId && details.thread_id !== threadId) return false

      // Exclude current user's own locks (by UUID).
      if (lockedById && lockedById === currentUser) return false

      return true
    })

    if (activeLock) {
      const details = activeLock.details as Record<string, unknown>
      return NextResponse.json({
        locked: true,
        lockedBy: (details.locked_by as string) || 'Coordinator',
        lockedAt: details.locked_at as string,
      })
    }

    return NextResponse.json({ locked: false })
  } catch (err) {
    console.error('[thread-lock] GET failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { interactionId } = body as {
      interactionId: string
    }

    if (!interactionId) {
      return NextResponse.json(
        { error: 'Missing interactionId' },
        { status: 400 }
      )
    }

    // Server-derived. A user can only release their own locks.
    const venueId = auth.venueId

    const supabase = createServiceClient()

    // Delete lock entries for this user + interaction within the TTL
    const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString()

    const { data: locks } = await supabase
      .from('activity_log')
      .select('id, details')
      .eq('venue_id', venueId)
      .eq('activity_type', 'thread_lock')
      .eq('entity_type', 'interaction')
      .eq('entity_id', interactionId)
      .gte('created_at', cutoff)

    // Delete locks belonging to the current user (UUID match against
    // server-derived auth.userId — clients cannot release another
    // coordinator's lock by guessing their name).
    const toDelete = (locks ?? []).filter((lock) => {
      const details = lock.details as Record<string, unknown> | null
      return details?.locked_by_id === auth.userId
    })

    if (toDelete.length > 0) {
      await supabase
        .from('activity_log')
        .delete()
        .in(
          'id',
          toDelete.map((l) => l.id)
        )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[thread-lock] DELETE failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
