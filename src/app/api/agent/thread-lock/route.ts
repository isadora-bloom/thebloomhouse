import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Thread Lock API
//
// POST — Acquire or refresh a thread lock (upsert into activity_log)
// GET  — Check for active locks on a thread
// DELETE — Release a thread lock
//
// Locks auto-expire after 10 minutes (stale check on read).
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 10 * 60 * 1000 // 10 minutes

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { venueId, interactionId, threadId, lockedBy } = body as {
      venueId: string
      interactionId: string
      threadId?: string
      lockedBy: string
    }

    if (!venueId || !interactionId || !lockedBy) {
      return NextResponse.json(
        { error: 'Missing venueId, interactionId, or lockedBy' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Insert a thread_lock activity log entry
    await supabase.from('activity_log').insert({
      venue_id: venueId,
      activity_type: 'thread_lock',
      entity_type: 'interaction',
      entity_id: interactionId,
      details: {
        locked_by: lockedBy,
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
    const { searchParams } = new URL(request.url)
    const venueId = searchParams.get('venueId')
    const interactionId = searchParams.get('interactionId')
    const threadId = searchParams.get('threadId')
    const currentUser = searchParams.get('currentUser')

    if (!venueId || (!interactionId && !threadId)) {
      return NextResponse.json(
        { error: 'Missing venueId and interactionId or threadId' },
        { status: 400 }
      )
    }

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

    // Filter out locks by the current user and find the most recent from someone else
    const activeLock = (locks ?? []).find((lock) => {
      const details = lock.details as Record<string, unknown> | null
      if (!details) return false
      const lockedBy = details.locked_by as string | undefined
      const lockedAt = details.locked_at as string | undefined

      // Check the locked_at field as well for freshness
      if (lockedAt) {
        const lockTime = new Date(lockedAt).getTime()
        if (Date.now() - lockTime > LOCK_TTL_MS) return false
      }

      // If threadId search, check it matches
      if (threadId && details.thread_id !== threadId) return false

      // Exclude current user's own locks
      if (currentUser && lockedBy === currentUser) return false

      return true
    })

    if (activeLock) {
      const details = activeLock.details as Record<string, unknown>
      return NextResponse.json({
        locked: true,
        lockedBy: details.locked_by as string,
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
    const body = await request.json()
    const { venueId, interactionId, lockedBy } = body as {
      venueId: string
      interactionId: string
      lockedBy: string
    }

    if (!venueId || !interactionId || !lockedBy) {
      return NextResponse.json(
        { error: 'Missing venueId, interactionId, or lockedBy' },
        { status: 400 }
      )
    }

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

    // Delete locks belonging to the current user
    const toDelete = (locks ?? []).filter((lock) => {
      const details = lock.details as Record<string, unknown> | null
      return details?.locked_by === lockedBy
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
