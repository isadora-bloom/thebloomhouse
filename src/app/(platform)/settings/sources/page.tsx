'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { SourceBacktracePanel } from '@/components/intel/source-backtrace-panel'

/**
 * Settings · Sources — re-attribute scheduling-tool bookings.
 *
 * The same panel surfaced in onboarding's launch step lives here so a
 * coordinator can re-run it any time (after a fresh Gmail import, after
 * onboarding more couples, or just on a hunch). Costs Gmail API quota
 * per scan, so the panel waits for an explicit click in this surface.
 */
export default function SourcesSettingsPage() {
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-sage-600 hover:text-sage-800 mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Settings
        </Link>
        <h1 className="font-heading text-2xl font-bold text-sage-900">
          Source Attribution
        </h1>
        <p className="text-sage-600 text-sm mt-1">
          Re-attribute couples whose recorded first-touch is a scheduling tool
          (Calendly / Acuity / HoneyBook / Dubsado) by finding the original
          inquiry email in Gmail.
        </p>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <SourceBacktracePanel />
      </div>
    </div>
  )
}
