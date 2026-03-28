import Link from 'next/link'
import { Flower2, LayoutDashboard, Heart } from 'lucide-react'

const venues = [
  { name: 'Rixey Manor', slug: 'rixey-manor', color: '#7D8471', accent: '#A6894A' },
  { name: 'The Kendall', slug: 'the-kendall', color: '#5D7A7A', accent: '#C4956A' },
  { name: 'Waverly Estate', slug: 'waverly-estate', color: '#8B7D6B', accent: '#B8908A' },
  { name: 'Barton Creek', slug: 'barton-creek', color: '#6B7F5E', accent: '#D4A574' },
]

export default function RootPage() {
  const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true'

  if (!isDemoMode) {
    // In production, redirect to inbox
    return (
      <meta httpEquiv="refresh" content="0;url=/agent/inbox" />
    )
  }

  return (
    <div className="min-h-screen bg-[#FDFAF6] flex flex-col items-center justify-center px-6 py-12">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-3">
        <Flower2 className="w-8 h-8 text-[#7D8471]" />
        <span className="font-heading text-2xl font-bold text-[#3D4435]">
          The Bloom House
        </span>
      </div>

      <p className="text-[#7D8471] text-lg mb-12 text-center max-w-md">
        Unified wedding venue intelligence. Agent, analytics, and couple portal in one platform.
      </p>

      {/* Entry Buttons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-lg mb-16">
        <Link
          href="/agent/inbox"
          className="flex items-center gap-4 px-6 py-5 bg-white border-2 border-[#7D8471]/20 rounded-2xl hover:border-[#7D8471] hover:shadow-lg transition-all group"
        >
          <div className="bg-[#7D8471]/10 p-3 rounded-xl group-hover:bg-[#7D8471]/20 transition-colors">
            <LayoutDashboard className="w-6 h-6 text-[#7D8471]" />
          </div>
          <div>
            <p className="font-heading font-bold text-[#3D4435] text-lg">Platform Dashboard</p>
            <p className="text-sm text-[#7D8471]">Agent, intel, and management</p>
          </div>
        </Link>

        <Link
          href="/couple/rixey-manor/"
          className="flex items-center gap-4 px-6 py-5 bg-white border-2 border-[#B8908A]/20 rounded-2xl hover:border-[#B8908A] hover:shadow-lg transition-all group"
        >
          <div className="bg-[#B8908A]/10 p-3 rounded-xl group-hover:bg-[#B8908A]/20 transition-colors">
            <Heart className="w-6 h-6 text-[#B8908A]" />
          </div>
          <div>
            <p className="font-heading font-bold text-[#3D4435] text-lg">Couple Portal</p>
            <p className="text-sm text-[#7D8471]">Wedding planning experience</p>
          </div>
        </Link>
      </div>

      {/* Venue Cards */}
      <div className="w-full max-w-2xl">
        <h2 className="font-heading text-sm font-semibold uppercase tracking-wider text-[#7D8471] mb-4 text-center">
          Crestwood Collection Venues
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {venues.map((venue) => (
            <div
              key={venue.slug}
              className="bg-white rounded-xl border border-gray-100 p-4 text-center hover:shadow-md transition-shadow"
            >
              <div
                className="w-10 h-10 rounded-full mx-auto mb-3 flex items-center justify-center"
                style={{ backgroundColor: venue.color + '20' }}
              >
                <Flower2 className="w-5 h-5" style={{ color: venue.color }} />
              </div>
              <p className="font-heading font-semibold text-sm text-[#3D4435]">
                {venue.name}
              </p>
              <div className="flex items-center justify-center gap-1.5 mt-2">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: venue.color }}
                />
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: venue.accent }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <p className="mt-16 text-xs text-[#7D8471]/60">
        Bloom House v1.0 &mdash; Demo Mode
      </p>
    </div>
  )
}
