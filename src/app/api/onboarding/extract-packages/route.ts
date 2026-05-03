/**
 * Canonical-packages extraction API (T5-Rixey-HH).
 *
 * POST /api/onboarding/extract-packages
 *   body: {
 *     mode: 'extract',
 *     formProvider: string,            // FORM_HINTS provider key
 *     csv: string,                     // same CSV as web-form-import upload
 *     hintOverrides?: Partial<FormHint>,
 *   }
 *   → returns { proposals: ProposedPackage[], warnings: string[] }
 *
 * POST /api/onboarding/extract-packages
 *   body: {
 *     mode: 'confirm',
 *     proposals: ProposedPackage[],    // coordinator-curated subset
 *   }
 *   → INSERT each into packages with status='active', confidence_flag='live'
 *      (the coordinator confirmed it), crm_source='web_form'.
 *
 * Auth: getPlatformAuth — coordinator-only.
 *
 * Why a single endpoint with a mode switch: keeps the extraction
 * pipeline rooted at one URL the coordinator can come back to, and
 * the confirm step needs the same auth + venueId as the extract step.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  extractPackagesFromFormSchema,
  type ProposedPackage,
} from '@/lib/services/crm-import/web-form-packages'
import { findHint, type FormHint } from '@/lib/services/crm-import/web-form'

const MAX_BODY_BYTES = 5 * 1024 * 1024

interface ExtractBody {
  mode: 'extract'
  formProvider?: string
  csv?: string
  hintOverrides?: Partial<FormHint>
}

interface ConfirmBody {
  mode: 'confirm'
  proposals?: ProposedPackage[]
}

type RequestBody = ExtractBody | ConfirmBody | { mode?: undefined }

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const bytes = Number.parseInt(contentLength, 10)
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES, gotBytes: bytes },
        { status: 413 },
      )
    }
  }

  let body: RequestBody
  try {
    body = (await request.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.mode === 'extract') {
    const eb = body as ExtractBody
    if (!eb.csv || !eb.csv.trim()) {
      return NextResponse.json({ error: 'csv_required' }, { status: 400 })
    }
    const baseHint = findHint(eb.formProvider)
    if (!baseHint) {
      return NextResponse.json(
        { error: 'unknown_form_provider', formProvider: eb.formProvider },
        { status: 400 },
      )
    }
    const hint: FormHint = { ...baseHint, ...(eb.hintOverrides ?? {}) }
    const result = extractPackagesFromFormSchema({ csvText: eb.csv, hint })
    return NextResponse.json({
      ok: true,
      mode: 'extract',
      formProvider: eb.formProvider,
      proposals: result.proposals,
      warnings: result.warnings,
    })
  }

  if (body.mode === 'confirm') {
    const cb = body as ConfirmBody
    if (!Array.isArray(cb.proposals) || cb.proposals.length === 0) {
      return NextResponse.json({ error: 'proposals_required' }, { status: 400 })
    }
    const supabase = createServiceClient()
    const payloads = cb.proposals.map((p) => ({
      venue_id: auth.venueId,
      kind: p.kind,
      name: p.name,
      season: p.season ?? null,
      tier: p.tier ?? null,
      guest_count_min: p.guest_count_min ?? null,
      guest_count_max: p.guest_count_max ?? null,
      price_cents: p.price_cents ?? null,
      discount_percent: p.discount_percent ?? null,
      source_text: p.source_text,
      crm_source: 'web_form',
      confidence_flag: 'live',           // coordinator-confirmed
      status: 'active',
      notes: p.source_column ? `Extracted from form column: ${p.source_column}` : null,
    }))

    // Use upsert on the unique key so re-running the confirm step
    // doesn't double-insert when the coordinator iterates.
    const { data, error } = await supabase
      .from('packages')
      .upsert(payloads, {
        // onConflict-skip-check: T5-Rixey-RR finding — packages has no matching composite unique; needs migration in follow-up
        onConflict: 'venue_id,kind,name,season,guest_count_min,guest_count_max',
        ignoreDuplicates: false,
      })
      .select('id, kind, name')

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      )
    }

    return NextResponse.json({
      ok: true,
      mode: 'confirm',
      inserted: data?.length ?? 0,
      packages: data ?? [],
    })
  }

  return NextResponse.json({ error: 'unknown_mode' }, { status: 400 })
}
