import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

const DEFAULT_STEPS = ['photo', 'chat', 'vendor', 'inspo', 'checklist']

// GET — list onboarding steps, auto-create defaults if none exist
export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('onboarding_progress')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)

    if (error) throw error

    // Auto-create default steps if no rows exist
    if (!data || data.length === 0) {
      const rows = DEFAULT_STEPS.map((step) => ({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        step,
        completed: false,
      }))

      const { data: created, error: insertError } = await supabase
        .from('onboarding_progress')
        .insert(rows)
        .select()

      if (insertError) throw insertError
      return NextResponse.json({ data: created })
    }

    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}

// PATCH — mark a step as completed
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { step } = body as { step?: string }
    if (!step) return badRequest('step is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('onboarding_progress')
      .update({
        completed: true,
        completed_at: new Date().toISOString(),
      })
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .eq('step', step)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}
