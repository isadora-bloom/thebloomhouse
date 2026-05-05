import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { Flower2, LayoutDashboard, Heart, ArrowRight } from 'lucide-react'
import {
  signDemoToken,
  DEMO_VENUE_ID,
  DEMO_TOKEN_COOKIE,
  DEMO_HINT_COOKIE,
  demoTokenCookieOptions,
  demoHintCookieOptions,
} from '@/lib/services/demo-token'

// DEMO_ORG_ID and the Hawthorne venue ID come from seed.sql. Hardcoded here so
// the scope cookie is set in the same server action that mints the signed token
// — no extra roundtrip, no client-side cookie writes.
const DEMO_ORG_ID = '11111111-1111-1111-1111-111111111111'

async function launchDemoAction(formData: FormData) {
  'use server'
  const destination = (formData.get('destination') as string | null) ?? '/'

  // Mint a signed, HttpOnly demo token. JS cannot read or forge this cookie.
  // Supabase sign-out is NOT done here (server action cannot call the client-
  // side Supabase client). The middleware clears demo cookies when an auth
  // session is detected — that remains the auth-collision guard.
  const token = signDemoToken({ demoVenueId: DEMO_VENUE_ID })

  const cookieStore = await cookies()

  // Auth-bearing token: HttpOnly so JS cannot read or overwrite it.
  cookieStore.set(DEMO_TOKEN_COOKIE, token, demoTokenCookieOptions())

  // Non-HttpOnly UI hint: client components that only need to KNOW the session
  // is a demo (banner, gear-menu role display, default IDs) read this instead
  // of the signed token, which is intentionally opaque to the browser.
  cookieStore.set(DEMO_HINT_COOKIE, '1', demoHintCookieOptions())

  // Retain the existing venue + scope cookies so legacy client components
  // (useVenueId, scope selector) continue to work during the migration window.
  const isCouplePortal = destination.startsWith('/couple/')
  const scope = isCouplePortal
    ? {
        level: 'venue',
        venueId: DEMO_VENUE_ID,
        orgId: DEMO_ORG_ID,
        venueName: 'Hawthorne Manor',
        companyName: 'The Crestwood Collection',
      }
    : {
        level: 'company',
        orgId: DEMO_ORG_ID,
        companyName: 'The Crestwood Collection',
      }
  const scopeOpts = { path: '/', maxAge: 86400, sameSite: 'lax' as const }
  cookieStore.set('bloom_venue', DEMO_VENUE_ID, scopeOpts)
  cookieStore.set('bloom_scope', JSON.stringify(scope), scopeOpts)

  redirect(destination)
}

export default function DemoEntryPage() {
  return (
    <div className="min-h-screen bg-[#FDFAF6] flex flex-col items-center justify-center px-6 py-12">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-3">
        <Flower2 className="w-8 h-8 text-[#7D8471]" />
        <span className="font-heading text-2xl font-bold text-[#3D4435]">
          The Bloom House
        </span>
      </div>

      <p className="text-[#7D8471] text-lg mb-2 text-center max-w-md">
        See the full platform in action with sample data.
      </p>

      <span className="inline-block px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded-full bg-amber-100 text-amber-700 mb-10">
        Interactive Demo
      </span>

      {/* Entry Buttons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-lg mb-12">
        <form action={launchDemoAction}>
          <input type="hidden" name="destination" value="/" />
          <button
            type="submit"
            className="w-full flex items-center gap-4 px-6 py-5 bg-white border-2 border-[#7D8471]/20 rounded-2xl hover:border-[#7D8471] hover:shadow-lg transition-all group text-left"
          >
            <div className="bg-[#7D8471]/10 p-3 rounded-xl group-hover:bg-[#7D8471]/20 transition-colors">
              <LayoutDashboard className="w-6 h-6 text-[#7D8471]" />
            </div>
            <div className="flex-1">
              <p className="font-heading font-bold text-[#3D4435] text-lg">Platform</p>
              <p className="text-sm text-[#7D8471]">Agent, intel & management</p>
            </div>
            <ArrowRight className="w-5 h-5 text-[#7D8471]/40 group-hover:text-[#7D8471] transition-colors" />
          </button>
        </form>

        <form action={launchDemoAction}>
          <input type="hidden" name="destination" value="/couple/hawthorne-manor/" />
          <button
            type="submit"
            className="w-full flex items-center gap-4 px-6 py-5 bg-white border-2 border-[#B8908A]/20 rounded-2xl hover:border-[#B8908A] hover:shadow-lg transition-all group text-left"
          >
            <div className="bg-[#B8908A]/10 p-3 rounded-xl group-hover:bg-[#B8908A]/20 transition-colors">
              <Heart className="w-6 h-6 text-[#B8908A]" />
            </div>
            <div className="flex-1">
              <p className="font-heading font-bold text-[#3D4435] text-lg">Couple Portal</p>
              <p className="text-sm text-[#7D8471]">Wedding planning experience</p>
            </div>
            <ArrowRight className="w-5 h-5 text-[#B8908A]/40 group-hover:text-[#B8908A] transition-colors" />
          </button>
        </form>
      </div>

      {/* Demo venues */}
      <div className="w-full max-w-lg">
        <h2 className="font-heading text-sm font-semibold uppercase tracking-wider text-[#7D8471] mb-4 text-center">
          Demo Portfolio: The Crestwood Collection
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { name: 'Hawthorne Manor', color: '#7D8471' },
            { name: 'Crestwood Farm', color: '#8B7355' },
            { name: 'The Glass House', color: '#3C3C3C' },
            { name: 'Rose Hill Gardens', color: '#B8908A' },
          ].map((venue) => (
            <div
              key={venue.name}
              className="bg-white rounded-xl border border-gray-100 p-3 text-center"
            >
              <div
                className="w-8 h-8 rounded-full mx-auto mb-2 flex items-center justify-center"
                style={{ backgroundColor: venue.color + '20' }}
              >
                <Flower2 className="w-4 h-4" style={{ color: venue.color }} />
              </div>
              <p className="font-heading font-semibold text-xs text-[#3D4435]">
                {venue.name}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Sign up CTA */}
      <div className="mt-12 text-center">
        <p className="text-sm text-[#7D8471] mb-3">Ready to use Bloom House with your venues?</p>
        <a
          href="/signup"
          className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#7D8471] text-white rounded-lg font-medium hover:bg-[#6B7361] transition-colors"
        >
          Sign Up
          <ArrowRight className="w-4 h-4" />
        </a>
      </div>
    </div>
  )
}
