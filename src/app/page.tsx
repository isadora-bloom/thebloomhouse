import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { Flower2, LayoutDashboard, Heart, ArrowRight } from 'lucide-react'

export default async function RootPage() {
  // If in demo mode, redirect to the platform
  const cookieStore = await cookies()
  if (cookieStore.get('bloom_demo')?.value === 'true') {
    redirect('/agent/inbox')
  }

  // If logged in, redirect to platform
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    redirect('/agent/inbox')
  }

  // Not logged in, not demo — show landing with clear paths
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

      {/* Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-lg mb-8">
        <Link
          href="/login"
          className="flex items-center gap-4 px-6 py-5 bg-white border-2 border-[#7D8471]/20 rounded-2xl hover:border-[#7D8471] hover:shadow-lg transition-all group"
        >
          <div className="bg-[#7D8471]/10 p-3 rounded-xl group-hover:bg-[#7D8471]/20 transition-colors">
            <LayoutDashboard className="w-6 h-6 text-[#7D8471]" />
          </div>
          <div className="flex-1">
            <p className="font-heading font-bold text-[#3D4435] text-lg">Sign In</p>
            <p className="text-sm text-[#7D8471]">Access your venues</p>
          </div>
          <ArrowRight className="w-5 h-5 text-[#7D8471]/40 group-hover:text-[#7D8471] transition-colors" />
        </Link>

        <Link
          href="/demo"
          className="flex items-center gap-4 px-6 py-5 bg-white border-2 border-amber-200 rounded-2xl hover:border-amber-400 hover:shadow-lg transition-all group"
        >
          <div className="bg-amber-50 p-3 rounded-xl group-hover:bg-amber-100 transition-colors">
            <Heart className="w-6 h-6 text-amber-600" />
          </div>
          <div className="flex-1">
            <p className="font-heading font-bold text-[#3D4435] text-lg">Try Demo</p>
            <p className="text-sm text-[#7D8471]">Explore with sample data</p>
          </div>
          <ArrowRight className="w-5 h-5 text-amber-400 group-hover:text-amber-600 transition-colors" />
        </Link>
      </div>

      <p className="text-sm text-[#7D8471]/60">
        New venue? <a href="/signup" className="underline hover:text-[#7D8471]">Create an account</a>
      </p>
    </div>
  )
}
