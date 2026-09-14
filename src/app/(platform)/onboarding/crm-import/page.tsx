'use client'

/**
 * CRM-import (T5-followup-Y / Pattern I closure).
 *
 * Day-3 onboarding-project sub-step. Thin wrapper around the shared
 * `CrmImportForm` (extracted W42) — this page keeps its route and its
 * place in the 5-day onboarding project; the form itself now also
 * renders at `/admin/imports/upload` for a coordinator who needs to
 * bring in a CSV any other day of the week.
 */

import { CrmImportForm } from '@/components/onboarding/CrmImportForm'

export default function CrmImportPage() {
  return <CrmImportForm />
}
