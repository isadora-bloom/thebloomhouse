'use client'

import { useRouter } from 'next/navigation'
import { Flower2, LayoutDashboard, Heart, ArrowRight } from 'lucide-react'

export default function DemoEntryPage() {
  const router = useRouter()

  function launchDemo(destination: string) {
    // Set demo cookie (1 day expiry)
    document.cookie = 'bloom_demo=true; path=/; max-age=86400'
    // Set demo venue cookie so scope selector picks up the right venue
    document.cookie = `bloom_venue=22222222-2222-2222-2222-222222222201; path=/; max-age=86400`
    document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify({
      level: 'venue',
      venueId: '22222222-2222-2222-2222-222222222201',
      venueName: 'Hawthorne Manor',
      companyName: 'The Crestwood Collection',
    }))}; path=/; max-age=86400`
    router.push(destination)
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

      <p className="text-[#7D8471] text-lg mb-2 text-center max-w-md">
        See the full platform in action with sample data.
      </p>

      <span className="inline-block px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded-full bg-amber-100 text-amber-700 mb-10">
        Interactive Demo
      </span>

      {/* Entry Buttons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-lg mb-12">
        <button
          onClick={() => launchDemo('/')}
          className="flex items-center gap-4 px-6 py-5 bg-white border-2 border-[#7D8471]/20 rounded-2xl hover:border-[#7D8471] hover:shadow-lg transition-all group text-left"
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

        <button
          onClick={() => launchDemo('/couple/hawthorne-manor/')}
          className="flex items-center gap-4 px-6 py-5 bg-white border-2 border-[#B8908A]/20 rounded-2xl hover:border-[#B8908A] hover:shadow-lg transition-all group text-left"
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
