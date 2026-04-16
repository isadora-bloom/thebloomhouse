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
      // 2. Create a fresh organisation (no venue yet — that happens in /setup)
      const { data: org, error: orgError } = await supabase
        .from('organisations')
        .insert({
          name: fullName ? `${fullName}'s Company` : 'My Company',
          owner_id: authData.user.id,
          is_demo: false,
        })
        .select('id')
        .single()

      if (orgError) {
        console.error('Failed to create organisation:', orgError)
        return NextResponse.json({ error: 'Failed to create organisation.' }, { status: 500 })
      }

      // 3. Create user_profile with org_admin role, NO venue_id yet
      const nameParts = (fullName || '').split(' ')
      const { error: profileError } = await supabase.from('user_profiles').insert({
        id: authData.user.id,
        venue_id: null,
        org_id: org.id,
        role: 'org_admin',
        first_name: nameParts[0] || null,
        last_name: nameParts.slice(1).join(' ') || null,
      })

      if (profileError) {
        console.error('Failed to create user_profile:', profileError)
      }

      return NextResponse.json({
        success: true,
        orgId: org.id,
        needsSetup: true,
      })
    }

    if (role === 'couple') {
      // Don't create orphan auth user — couples register via event code
      return NextResponse.json({
        error: 'Couples register through their venue invitation link, not direct signup. Ask your venue coordinator for your event code.',
        coupleRedirect: true
      }, { status: 400 })
    }

    // Unknown role
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Signup error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
