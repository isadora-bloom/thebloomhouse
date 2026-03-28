import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List sequence templates or active enrollments
//   ?active=true  → active wedding_sequences with wedding + template info
//   (default)     → templates with enrollment counts
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const supabase = createServiceClient()

    // ── Active enrollments mode ────────────────────────────────────────
    if (searchParams.get('active') === 'true') {
      const { data: sequences, error } = await supabase
        .from('wedding_sequences')
        .select(`
          id,
          status,
          current_step,
          enrolled_at,
          paused_at,
          weddings:wedding_id(id, couple_names, wedding_date),
          template:template_id(id, name)
        `)
        .eq('venue_id', auth.venueId)
        .eq('status', 'active')
        .order('enrolled_at', { ascending: false })

      if (error) throw error
      return NextResponse.json({ sequences: sequences ?? [] })
    }

    // ── Template list mode ─────────────────────────────────────────────
    const { data: templates, error } = await supabase
      .from('follow_up_sequence_templates')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })

    if (error) throw error

    // Count active enrollments per template
    const templateIds = (templates ?? []).map((t) => t.id)

    const { data: enrollments } = templateIds.length > 0
      ? await supabase
          .from('wedding_sequences')
          .select('template_id')
          .eq('venue_id', auth.venueId)
          .eq('status', 'active')
          .in('template_id', templateIds)
      : { data: [] }

    const countMap = new Map<string, number>()
    for (const e of enrollments ?? []) {
      countMap.set(e.template_id, (countMap.get(e.template_id) ?? 0) + 1)
    }

    const templatesWithCounts = (templates ?? []).map((t) => ({
      ...t,
      active_enrollments: countMap.get(t.id) ?? 0,
    }))

    return NextResponse.json({ templates: templatesWithCounts })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Create template OR enroll a wedding
//   ?action=enroll  → enroll wedding. Body: { wedding_id, template_id }
//   (default)       → create template. Body: { name, trigger, steps, is_active }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const body = await request.json()
    const supabase = createServiceClient()

    // ── Enroll a wedding ───────────────────────────────────────────────
    if (searchParams.get('action') === 'enroll') {
      const { wedding_id, template_id } = body

      if (!wedding_id || typeof wedding_id !== 'string') {
        return badRequest('Missing or invalid wedding_id')
      }
      if (!template_id || typeof template_id !== 'string') {
        return badRequest('Missing or invalid template_id')
      }

      const { data, error } = await supabase
        .from('wedding_sequences')
        .insert({
          venue_id: auth.venueId,
          wedding_id,
          template_id,
          status: 'active',
          current_step: 0,
          enrolled_at: new Date().toISOString(),
        })
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ enrollment: data }, { status: 201 })
    }

    // ── Create template ────────────────────────────────────────────────
    const { name, trigger, steps, is_active } = body

    if (!name || typeof name !== 'string') {
      return badRequest('Missing or invalid name')
    }

    const { data, error } = await supabase
      .from('follow_up_sequence_templates')
      .insert({
        venue_id: auth.venueId,
        name,
        trigger: trigger ?? null,
        steps: steps ?? [],
        is_active: is_active ?? true,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ template: data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Update template OR manage enrollment status
//   ?action=pause   → pause enrollment.  Body: { id }
//   ?action=resume  → resume enrollment. Body: { id }
//   ?action=cancel  → cancel enrollment. Body: { id }
//   (default)       → update template.   Body: { id, ...fields }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const body = await request.json()
    const action = searchParams.get('action')
    const supabase = createServiceClient()

    // ── Enrollment status changes ──────────────────────────────────────
    if (action === 'pause' || action === 'resume' || action === 'cancel') {
      const { id } = body
      if (!id || typeof id !== 'string') {
        return badRequest('Missing or invalid id')
      }

      const updates: Record<string, unknown> = {}

      if (action === 'pause') {
        updates.status = 'paused'
        updates.paused_at = new Date().toISOString()
      } else if (action === 'resume') {
        updates.status = 'active'
        updates.paused_at = null
      } else if (action === 'cancel') {
        updates.status = 'cancelled'
        updates.completed_at = new Date().toISOString()
      }

      const { data, error } = await supabase
        .from('wedding_sequences')
        .update(updates)
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ sequence: data })
    }

    // ── Update template ────────────────────────────────────────────────
    const { id, ...fields } = body
    if (!id || typeof id !== 'string') {
      return badRequest('Missing or invalid id')
    }

    // Only allow known fields
    const allowed = ['name', 'trigger', 'steps', 'is_active']
    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in fields) updates[key] = fields[key]
    }

    if (Object.keys(updates).length === 0) {
      return badRequest('No valid fields to update')
    }

    const { data, error } = await supabase
      .from('follow_up_sequence_templates')
      .update(updates)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ template: data })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// DELETE — Delete a sequence template by id
//   ?id=<template_id>
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) return badRequest('Missing id query parameter')

    const supabase = createServiceClient()

    const { error } = await supabase
      .from('follow_up_sequence_templates')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
