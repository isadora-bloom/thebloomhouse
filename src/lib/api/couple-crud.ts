import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from './auth-helpers'
import { logActivity } from '@/lib/services/activity-logger'
import { createNotification } from '@/lib/services/admin-notifications'

// ---------------------------------------------------------------------------
// Generic CRUD factory for couple planning tables
// All tables share: venue_id, wedding_id, and standard CRUD needs
// ---------------------------------------------------------------------------

interface CrudOptions {
  table: string
  // Fields allowed in POST/PATCH body (exclude id, venue_id, wedding_id, timestamps)
  allowedFields: string[]
  // Default sort column
  orderBy?: string
  orderAsc?: boolean
  // Optional select override (for joins)
  select?: string
  // If true, couple can only read (venue-level data like accommodations)
  readOnly?: boolean
}

export function createCoupleCrud(options: CrudOptions) {
  const {
    table,
    allowedFields,
    orderBy = 'created_at',
    orderAsc = true,
    select = '*',
    readOnly = false,
  } = options

  // GET — list items for couple's wedding
  async function GET(request: NextRequest) {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    try {
      const supabase = createServiceClient()
      const { searchParams } = new URL(request.url)
      const limit = Math.min(parseInt(searchParams.get('limit') ?? '500', 10), 1000)

      let query = supabase
        .from(table)
        .select(select)
        .eq('venue_id', auth.venueId)

      // Some tables (accommodations, borrow_catalog) are venue-level, not wedding-level
      if (!['accommodations', 'borrow_catalog'].includes(table)) {
        query = query.eq('wedding_id', auth.weddingId)
      }

      query = query.order(orderBy, { ascending: orderAsc }).limit(limit)

      const { data, error } = await query
      if (error) throw error

      return NextResponse.json({ data })
    } catch (error) {
      return serverError(error)
    }
  }

  // POST — create new item
  async function POST(request: NextRequest) {
    if (readOnly) return badRequest('This resource is read-only')
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    try {
      const body = await request.json()
      const supabase = createServiceClient()

      // Filter to allowed fields only
      const record: Record<string, unknown> = {
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
      }
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          record[field] = body[field]
        }
      }

      const { data, error } = await supabase
        .from(table)
        .insert(record)
        .select()
        .single()

      if (error) throw error

      // Fire-and-forget activity log + notification
      logActivity({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        userId: auth.userId,
        activityType: `${table}_created`,
        entityType: table,
        entityId: data?.id,
        details: { fields: Object.keys(record).filter(k => k !== 'venue_id' && k !== 'wedding_id') },
      })
      createNotification({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        type: 'client_activity',
        title: `New ${table.replace(/_/g, ' ')} added`,
        body: `A couple added a new ${table.replace(/_/g, ' ')} record.`,
      })

      return NextResponse.json({ data }, { status: 201 })
    } catch (error) {
      return serverError(error)
    }
  }

  // PATCH — update item by id
  async function PATCH(request: NextRequest) {
    if (readOnly) return badRequest('This resource is read-only')
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    try {
      const body = await request.json()
      const { id } = body
      if (!id) return badRequest('id is required')

      const supabase = createServiceClient()

      // Filter to allowed fields only
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updates[field] = body[field]
        }
      }

      const { data, error } = await supabase
        .from(table)
        .update(updates)
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .select()
        .single()

      if (error) throw error

      // Fire-and-forget activity log
      logActivity({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        userId: auth.userId,
        activityType: `${table}_updated`,
        entityType: table,
        entityId: id,
        details: { updatedFields: Object.keys(updates).filter(k => k !== 'updated_at') },
      })

      return NextResponse.json({ data })
    } catch (error) {
      return serverError(error)
    }
  }

  // DELETE — delete item by id
  async function DELETE(request: NextRequest) {
    if (readOnly) return badRequest('This resource is read-only')
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    try {
      const { searchParams } = new URL(request.url)
      const id = searchParams.get('id')
      if (!id) return badRequest('id query parameter is required')

      const supabase = createServiceClient()

      const { error } = await supabase
        .from(table)
        .delete()
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)

      if (error) throw error

      // Fire-and-forget activity log + notification
      logActivity({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        userId: auth.userId,
        activityType: `${table}_deleted`,
        entityType: table,
        entityId: id,
      })
      createNotification({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        type: 'client_activity',
        title: `${table.replace(/_/g, ' ')} removed`,
        body: `A couple removed a ${table.replace(/_/g, ' ')} record.`,
      })

      return NextResponse.json({ success: true })
    } catch (error) {
      return serverError(error)
    }
  }

  return { GET, POST, PATCH, DELETE }
}
