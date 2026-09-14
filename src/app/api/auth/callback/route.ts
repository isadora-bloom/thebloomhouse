import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * OAuth / magic-link callback.
 *
 * 2026-09-14 security remediation (S1, item 3c): the redirects used to be
 * built from `origin`, which Next derives from the request URL and
 * therefore from the Host header. A caller who controls Host controls
 * where a freshly-exchanged session lands — and the session cookie is set
 * before the redirect, so the landing page is reached with the user
 * already signed in.
 *
 * A relative Location cannot be pointed anywhere: the browser resolves it
 * against the URL it actually requested, so a forged Host never reaches
 * the response at all. NextResponse.redirect insists on an absolute URL,
 * so the header goes on by hand.
 */
function redirectTo(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path } })
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    const supabase = await createServerSupabaseClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      return redirectTo('/agent/inbox')
    }
  }

  // If no code or exchange failed, redirect to login
  return redirectTo('/login')
}
