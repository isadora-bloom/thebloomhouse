'use client'

/**
 * Import a file — admin Imports page action (W42, Monday-walkthrough audit).
 *
 * The audit found the only upload entry point was buried under
 * `/onboarding/crm-import`, a step in the one-time 5-day onboarding
 * project. A coordinator back on a Monday with a fresh Knot or
 * HoneyBook export had nowhere to bring it in from the admin side —
 * `/admin/imports` only reprocessed files already on disk.
 *
 * This route renders the identical `CrmImportForm` the onboarding
 * project uses: same adapters, same dedup, same summary, same
 * `/api/onboarding/crm-import` endpoint. No new upload route, no
 * second import path to keep in sync.
 */

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { CrmImportForm } from '@/components/onboarding/CrmImportForm'

export default function AdminImportUploadPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <Link
        href="/admin/imports"
        className="inline-flex items-center gap-1.5 text-sm text-sage-600 hover:text-sage-900"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden />
        Back to imports
      </Link>
      <CrmImportForm />
    </div>
  )
}
