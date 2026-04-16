import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function POST(request: NextRequest) {
  try {
    const { email, password, role, fullName } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // 1. Create auth user (service role so we can set email_confirm: true)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    })

    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 400 })
    }

    if (role === 'coordinator' || role === 'venue_manager') {
      // 2. Create a fresh organisation
      const { data: org, error: orgError } = await supabase
        .from('organisations')
        .insert({
          name: fullName ? `${fullName}'s Venues` : 'My Venues',
          owner_id: authData.user.id,
          is_demo: false,
        })
        .select('id')
        .single()

      if (orgError) {
        console.error('Failed to create organisation:', orgError)
        return NextResponse.json({ error: 'Failed to create organisation.' }, { status: 500 })
      }

      // 3. Create a fresh venue with a temporary slug
      const slug = `venue-${Date.now()}`
      const { data: venue, error: venueError } = await supabase
        .from('venues')
        .insert({
          name: 'My Venue',
          slug,
          org_id: org.id,
          status: 'trial',
          is_demo: false,
        })
        .select('id')
        .single()

      if (venueError) {
        console.error('Failed to create venue:', venueError)
        return NextResponse.json({ error: 'Failed to create venue.' }, { status: 500 })
      }

      // 4. Create venue_config with onboarding_completed = false
      const { error: configError } = await supabase.from('venue_config').insert({
        venue_id: venue.id,
        business_name: 'My Venue',
        timezone: 'America/New_York',
        onboarding_completed: false,
      })

      if (configError) {
        console.error('Failed to create venue_config:', configError)
      }

      // 5. Create user_profile linked to the new venue
      const nameParts = (fullName || '').split(' ')
      const { error: profileError } = await supabase.from('user_profiles').insert({
        id: authData.user.id,
        venue_id: venue.id,
        org_id: org.id,
        role: 'coordinator',
        first_name: nameParts[0] || null,
        last_name: nameParts.slice(1).join(' ') || null,
      })

      if (profileError) {
        console.error('Failed to create user_profile:', profileError)
      }

      return NextResponse.json({
        success: true,
        venueId: venue.id,
        needsOnboarding: true,
      })
    }

    // Couple signup — just create the auth user, no venue
    // (Couple flow creates profile via event code registration)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Signup error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
