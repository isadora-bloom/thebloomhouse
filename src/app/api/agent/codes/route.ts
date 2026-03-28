import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List all client codes for venue
//   Joins with weddings for couple_names
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('client_codes')
      .select(`
        id,
        code,
        format_template,
        created_at,
        wedding:wedding_id(id, wedding_date, status, people!people_wedding_id_fkey(role, first_name, last_name))
      `)
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })

    if (error) throw error

    // Build couple_names from people join
    const codes = (data ?? []).map((row: any) => {
      const people = row.wedding?.people ?? []
      const partners = people.filter((p: any) => p.role === 'partner1' || p.role === 'partner2')
      const names = partners.map((p: any) => [p.first_name, p.last_name].filter(Boolean).join(' ')).filter(Boolean)
      return {
        ...row,
        wedding: {
          ...row.wedding,
          couple_names: names.length > 0 ? names.join(' & ') : null,
          people: undefined,
        },
      }
    })

    return NextResponse.json({ codes })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Generate a client code for a wedding
//   Body: { wedding_id, format_template? }
//   Auto-generates: VENUE_SLUG-XXXX (4-digit random, unique)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { wedding_id, format_template } = body

    if (!wedding_id || typeof wedding_id !== 'string') {
      return badRequest('Missing or invalid wedding_id')
    }

    const supabase = createServiceClient()

    // Get venue slug for code prefix
    const { data: venue, error: venueError } = await supabase
      .from('venues')
      .select('slug')
      .eq('id', auth.venueId)
      .single()

    if (venueError || !venue) {
      return badRequest('Could not find venue')
    }

    const prefix = venue.slug.toUpperCase().replace(/[^A-Z0-9]/g, '')

    // Generate unique code with retry
    let code = ''
    let attempts = 0
    const maxAttempts = 10

    while (attempts < maxAttempts) {
      const random = Math.floor(1000 + Math.random() * 9000) // 4-digit: 1000-9999
      code = `${prefix}-${random}`

      // Check uniqueness
      const { data: existing } = await supabase
        .from('client_codes')
        .select('id')
        .eq('code', code)
        .maybeSingle()

      if (!existing) break
      attempts++
    }

    if (attempts >= maxAttempts) {
      return badRequest('Could not generate unique code. Try again.')
    }

    // Insert the code
    const { data, error } = await supabase
      .from('client_codes')
      .insert({
        venue_id: auth.venueId,
        wedding_id,
        code,
        format_template: format_template ?? null,
      })
      .select(`
        id,
        code,
        format_template,
        created_at,
        wedding:wedding_id(id, wedding_date, status, people!people_wedding_id_fkey(role, first_name, last_name))
      `)
      .single()

    if (error) throw error

    // Build couple_names from people join
    const row = data as any
    const people = row?.wedding?.people ?? []
    const partners = people.filter((p: any) => p.role === 'partner1' || p.role === 'partner2')
    const names = partners.map((p: any) => [p.first_name, p.last_name].filter(Boolean).join(' ')).filter(Boolean)
    const client_code = {
      ...row,
      wedding: {
        ...row?.wedding,
        couple_names: names.length > 0 ? names.join(' & ') : null,
        people: undefined,
      },
    }

    return NextResponse.json({ client_code }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
