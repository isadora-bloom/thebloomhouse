import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function getAuthVenue() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('venue_id')
    .eq('id', user.id)
    .single()

  return profile?.venue_id
    ? { userId: user.id, venueId: profile.venue_id as string }
    : null
}

// ---------------------------------------------------------------------------
// GET — List upcoming reminders for a venue
//   Derives reminders from:
//     - Checklist items with due dates in the next 30 days
//     - Weddings with upcoming dates in the next 90 days
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()
    const now = new Date()

    // Checklist items due in the next 30 days
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const { data: checklistItems } = await supabase
      .from('checklist_items')
      .select(`
        id,
        title,
        due_date,
        status,
        wedding_id,
        weddings:wedding_id (
          id,
          wedding_date,
          people (first_name, last_name, role)
        )
      `)
      .eq('venue_id', auth.venueId)
      .neq('status', 'completed')
      .lte('due_date', thirtyDaysFromNow)
      .gte('due_date', now.toISOString().split('T')[0])
      .order('due_date', { ascending: true })

    // Weddings with dates in the next 90 days
    const ninetyDaysFromNow = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const { data: upcomingWeddings } = await supabase
      .from('weddings')
      .select(`
        id,
        wedding_date,
        status,
        guest_count_estimate,
        people (first_name, last_name, role)
      `)
      .eq('venue_id', auth.venueId)
      .in('status', ['booked', 'confirmed'])
      .lte('wedding_date', ninetyDaysFromNow)
      .gte('wedding_date', now.toISOString().split('T')[0])
      .order('wedding_date', { ascending: true })

    // Build reminder objects
    const reminders = []

    // Checklist reminders
    for (const item of checklistItems ?? []) {
      const dueDate = new Date(item.due_date as string)
      const daysUntilDue = Math.ceil(
        (dueDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
      )

      reminders.push({
        type: 'checklist' as const,
        id: item.id,
        title: item.title,
        dueDate: item.due_date,
        daysUntilDue,
        urgency: daysUntilDue <= 3 ? 'high' : daysUntilDue <= 7 ? 'medium' : 'low',
        weddingId: item.wedding_id,
        wedding: item.weddings ?? null,
      })
    }

    // Upcoming wedding reminders
    for (const wedding of upcomingWeddings ?? []) {
      const weddingDate = new Date(wedding.wedding_date as string)
      const daysUntilWedding = Math.ceil(
        (weddingDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
      )

      const people = (wedding.people ?? []) as Array<{
        first_name: string
        last_name: string
        role: string
      }>
      const partners = people.filter(
        (p) => p.role === 'partner1' || p.role === 'partner2'
      )
      const coupleNames = partners.map((p) => p.first_name).join(' & ') || 'TBD'

      reminders.push({
        type: 'wedding' as const,
        id: wedding.id,
        title: `${coupleNames} — Wedding Day`,
        dueDate: wedding.wedding_date,
        daysUntilDue: daysUntilWedding,
        urgency: daysUntilWedding <= 7 ? 'high' : daysUntilWedding <= 30 ? 'medium' : 'low',
        weddingId: wedding.id,
        guestCount: wedding.guest_count_estimate,
      })
    }

    // Sort all reminders by due date
    reminders.sort((a, b) => {
      const dateA = new Date(a.dueDate as string).getTime()
      const dateB = new Date(b.dueDate as string).getTime()
      return dateA - dateB
    })

    return NextResponse.json({ reminders })
  } catch (err) {
    console.error('[api/portal/reminders] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Send a reminder (placeholder — actual sending is a TODO)
//   Body: {
//     type: 'checklist' | 'wedding' | 'custom',
//     targetId: string,
//     message?: string
//   }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { type, targetId, message } = body

    const validTypes = ['checklist', 'wedding', 'custom']
    if (!type || !validTypes.includes(type)) {
      return NextResponse.json(
        { error: `Invalid type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      )
    }

    if (!targetId || typeof targetId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid targetId' },
        { status: 400 }
      )
    }

    // TODO: Implement actual reminder sending (email, push notification, etc.)
    // For now, log the reminder request and return success
    console.log(
      `[api/portal/reminders] Reminder requested: type=${type}, targetId=${targetId}, venue=${auth.venueId}`
    )

    // Log the reminder attempt in the database for tracking
    const supabase = createServiceClient()

    await supabase.from('activity_log').insert({
      venue_id: auth.venueId,
      user_id: auth.userId,
      action: 'reminder_requested',
      entity_type: type,
      entity_id: targetId,
      metadata: { message: message ?? null },
    })

    return NextResponse.json({
      success: true,
      message: 'Reminder logged. Actual sending is not yet implemented.',
      type,
      targetId,
    })
  } catch (err) {
    console.error('[api/portal/reminders] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
