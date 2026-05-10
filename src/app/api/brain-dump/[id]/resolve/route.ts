import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { detectCsvShape, parseCsvRows } from '@/lib/services/brain-dump/csv-shape'
import { runCsvImport } from '@/app/api/brain-dump/route'
import { importReviews } from '@/lib/services/brain-dump/imports'
import { importStorefrontAnalytics } from '@/lib/services/ingestion/storefront-analytics'
import { upsertSpendRows, type SpendRow } from '@/lib/services/intel/marketing-spend'
import { createNotification } from '@/lib/services/admin-notifications'
import { nextHrefFor } from '@/lib/services/brain-dump'
import {
  isCsvPreview,
  isVisionReviews,
  isVisionStorefrontAnalytics,
  isProposedClientNote,
  isProposedKbRows,
  isProposedOperationalNote,
  isPdfPreview,
  readParseResultKind,
} from '@/lib/services/brain-dump/parse-result-schema'

/**
 * Resolve a pending brain-dump clarification.
 *
 * POST /api/brain-dump/:id/resolve
 * Body: { action: 'confirm' | 'dismiss', answer?: string }
 *
 * On confirm:
 *   - If parse_result describes a CSV preview (shape + storagePath), the
 *     CSV is re-downloaded from storage, parsed, and imported via the
 *     same pipeline that runs small CSVs inline.
 *   - If parse_result contains a vision reviews array that was parked
 *     for confirmation, import those reviews.
 *   - Otherwise, we just stamp clarification_answer + resolved_at.
 *
 * Dismiss always simply stamps status + resolved_at.
 *
 * Venue-scoped: the entry's venue_id must match the caller's venue.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing entry id' }, { status: 400 })

  let body: { action?: string; answer?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const action = body.action
  if (action !== 'confirm' && action !== 'dismiss') {
    return NextResponse.json({ error: 'action must be "confirm" or "dismiss"' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: entry, error: fetchErr } = await supabase
    .from('brain_dump_entries')
    .select('id, venue_id, parse_status, parse_result')
    .eq('id', id)
    .single()
  if (fetchErr || !entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if (entry.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (action === 'dismiss') {
    await supabase.from('brain_dump_entries').update({
      parse_status: 'dismissed',
      resolved_at: new Date().toISOString(),
    }).eq('id', id)
    return NextResponse.json({ id, status: 'dismissed' })
  }

  // Confirm — look for an actionable preview in parse_result.
  // Bug 11 (2026-05-09): readers narrow with type guards on the
  // discriminated `kind` field. Legacy rows persisted before Bug 11
  // have no `kind`, so a fallback to the historical heuristic
  // (sniff `pr.shape`, `pr.vision`, etc.) preserves back-compat reads.
  const pr = (entry.parse_result ?? {}) as Record<string, unknown>
  const prKind = readParseResultKind(pr)

  // Case A: CSV preview. New writes carry kind='csv_preview'; legacy
  // rows have shape + storagePath at the top level.
  const isLegacyCsv =
    !prKind &&
    pr.shape &&
    pr.storagePath &&
    typeof pr.shape === 'string' &&
    typeof pr.storagePath === 'string'
  if (isCsvPreview(pr) || isLegacyCsv) {
    const shape = (pr as { shape: string }).shape
    const storagePath = (pr as { storagePath: string }).storagePath
    const { data: file } = await supabase.storage.from('brain-dump').download(storagePath)
    if (!file) {
      return NextResponse.json({ error: 'Stored CSV could not be read' }, { status: 500 })
    }

    // Wave 4 Phase 4c: route the confirmed CSV through the unified
    // import-router so adapter shapes (honeybook / aisleplanner /
    // dubsado / tour_scheduler / web_form / web_form_packages) hit
    // their actual provider adapter instead of falling through to
    // platform-signals. Generic shapes (leads / reviews / etc) keep
    // working — the router delegates them back to runCsvImport.
    // The router also persists raw bytes to crm-imports + writes an
    // import_runs audit row + enqueues identity-reconstruction for
    // every wedding the import touches.
    const fileName = (pr as { filename?: unknown }).filename
    const safeFileName =
      typeof fileName === 'string' && fileName.trim().length > 0
        ? fileName
        : storagePath.split('/').pop() ?? 'brain-dump.csv'
    const buffer = Buffer.from(await file.arrayBuffer())
    const { routeAndProcessUpload } = await import(
      '@/lib/services/import-router/route-and-process'
    )
    const result = await routeAndProcessUpload({
      venueId: auth.venueId,
      supabase,
      fileBuffer: buffer,
      filename: safeFileName,
      mimeType: 'text/csv',
      sourcePath: 'brain-dump',
      ingestedBy: auth.userId,
    })
    const summary = {
      inserted: result.rowsInserted,
      updated: result.rowsUpdated,
      skipped: result.rowsSkipped,
      errors: result.errors,
      importRunId: result.importRunId,
      detectedShape: result.detectedShape,
      adapterUsed: result.adapterUsed,
      reconstructionEnqueuedCount: result.reconstructionEnqueuedCount,
      skipReasons: result.skipReasons,
    }
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      parse_result: { ...pr, summary, confirmed_at: new Date().toISOString() },
      resolved_at: new Date().toISOString(),
    }).eq('id', id)
    const next = nextHrefFor({ intent: `${shape}_preview` })
    return NextResponse.json({
      id,
      status: 'confirmed',
      importSummary: summary,
      nextHref: next?.nextHref ?? null,
      nextLabel: next?.nextLabel ?? null,
    })
  }

  // Case B: Vision output parked for confirm — reviews, storefront
  // analytics, or other. New writes carry kind='vision_reviews' or
  // kind='vision_storefront_analytics'; legacy rows expose v.intent on
  // a `vision` sub-object.
  const legacyVision =
    !prKind && pr.vision && typeof pr.vision === 'object'
      ? (pr.vision as {
          intent?: string
          reviews?: Array<{ reviewer_name: string; rating: number; body: string; review_date?: string | null; source?: string }>
          analytics?: { source?: string; metric?: string; rows?: Array<{ label: string; value: number }> }
        })
      : null

  if (
    isVisionReviews(pr) ||
    (legacyVision && legacyVision.intent === 'reviews' && legacyVision.reviews?.length)
  ) {
    const reviewsSrc = isVisionReviews(pr)
      ? pr.reviews
      : (legacyVision!.reviews ?? [])
    const summary = await importReviews({
      supabase,
      venueId: auth.venueId,
      rows: reviewsSrc.map((r) => ({
        source: (r.source ?? 'other').toLowerCase(),
        reviewer_name: r.reviewer_name,
        rating: r.rating,
        body: r.body,
        review_date: r.review_date ?? null,
      })),
    })
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      parse_result: { ...pr, summary, confirmed_at: new Date().toISOString() },
      resolved_at: new Date().toISOString(),
    }).eq('id', id)
    const next = nextHrefFor({ intent: 'reviews_from_screenshot' })
    return NextResponse.json({
      id,
      status: 'confirmed',
      importSummary: summary,
      nextHref: next?.nextHref ?? null,
      nextLabel: next?.nextLabel ?? null,
    })
  }

  if (
    isVisionStorefrontAnalytics(pr) ||
    (legacyVision && legacyVision.intent === 'storefront_analytics' && legacyVision.analytics?.rows?.length)
  ) {
    const analytics = isVisionStorefrontAnalytics(pr)
      ? pr.analytics
      : legacyVision!.analytics!
    const summary = await importStorefrontAnalytics({
      supabase,
      venueId: auth.venueId,
      input: {
        source: analytics.source ?? 'other',
        metric: analytics.metric ?? 'other',
        rows: analytics.rows ?? [],
        brainDumpEntryId: id,
      },
    })
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      parse_result: { ...pr, summary, confirmed_at: new Date().toISOString() },
      routed_to: [{ table: 'engagement_events', action: `storefront_analytics:${summary.inserted}`, id: null }],
      resolved_at: new Date().toISOString(),
    }).eq('id', id)
    const next = nextHrefFor({ intent: 'storefront_analytics_preview' })
    return NextResponse.json({
      id,
      status: 'confirmed',
      importSummary: summary,
      nextHref: next?.nextHref ?? null,
      nextLabel: next?.nextLabel ?? null,
    })
  }

  // Case D: proposed client note for couple's forensic record. Per
  // Playbook INV-20.5.4-D, per-couple intel paragraphs are non-
  // graduable and require explicit confirmation before filing to
  // weddings.sage_context_notes. Pre-fix the brain-dump auto-filed;
  // now we propose, the coordinator confirms here.
  //
  // Bug 11: prefer the discriminated `kind` narrow; fall back to the
  // legacy `proposed_client_note` sub-object for pre-fix rows.
  const legacyClientNote = pr['proposed_client_note'] as
    | { kind?: string; weddingId?: string; noteBody?: string; coupleLabel?: string | null }
    | undefined
  const proposedNote = isProposedClientNote(pr)
    ? {
        weddingId: pr.weddingId,
        noteBody: pr.noteBody,
        coupleLabel: pr.coupleLabel,
      }
    : legacyClientNote?.kind === 'client_note' &&
      legacyClientNote.weddingId &&
      legacyClientNote.noteBody
      ? {
          weddingId: legacyClientNote.weddingId,
          noteBody: legacyClientNote.noteBody,
          coupleLabel: legacyClientNote.coupleLabel ?? null,
        }
      : null
  if (proposedNote) {
    // Re-fetch existing notes inside the confirm to avoid stomping on
    // a parallel note that landed between propose and confirm.
    const { data: wRow } = await supabase
      .from('weddings')
      .select('sage_context_notes, venue_id')
      .eq('id', proposedNote.weddingId)
      .single()
    if (!wRow || wRow.venue_id !== auth.venueId) {
      return NextResponse.json({ error: 'Wedding not found or out of scope' }, { status: 404 })
    }
    const existing = Array.isArray(wRow.sage_context_notes)
      ? (wRow.sage_context_notes as Array<Record<string, unknown>>)
      : []
    const nextNotes = [
      ...existing,
      {
        body: proposedNote.noteBody,
        source: 'brain_dump',
        added_at: new Date().toISOString(),
        entry_id: id,
        confirmed_by: auth.userId,
      },
    ]
    const { error: writeErr } = await supabase
      .from('weddings')
      .update({ sage_context_notes: nextNotes })
      .eq('id', proposedNote.weddingId)
    if (writeErr) {
      return NextResponse.json({ error: writeErr.message }, { status: 500 })
    }
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      resolved_at: new Date().toISOString(),
      parse_result: { ...pr, confirmed_at: new Date().toISOString() },
      routed_to: [{ table: 'weddings', id: proposedNote.weddingId, action: 'append_sage_context_note' }],
    }).eq('id', id)

    // 2026-05-09 user mandate: continuous profile enrichment. The brain-
    // dump confirm path means a coordinator just told us something new
    // about this couple — the perfect moment to also re-scan for soft
    // context the body extractor may have missed and any structured
    // fields the brain-dump narrative implies. Best-effort, never block
    // the resolve response.
    void (async () => {
      try {
        const { enrichProfileFromTouchpoints } = await import('@/lib/services/identity/profile-enrichment')
        await enrichProfileFromTouchpoints(proposedNote.weddingId, {
          trigger: 'brain_dump_confirm',
        })
      } catch (err) {
        console.warn('[brain-dump/resolve] profile-enrichment failed:', err instanceof Error ? err.message : err)
      }
    })()

    const next = nextHrefFor({ intent: 'client_note', weddingId: proposedNote.weddingId })
    return NextResponse.json({
      id,
      status: 'confirmed',
      appendedTo: proposedNote.weddingId,
      nextHref: next?.nextHref ?? null,
      nextLabel: next?.nextLabel ?? null,
    })
  }

  // Case E: proposed knowledge_base rows. Per INV-20.5.4-A, even
  // additive content is propose-and-confirm. Insert with venue
  // auth check + dedup against existing (venue_id, question) pairs.
  // Bug 11: prefer discriminated narrow; fall back to legacy
  // `proposed_kb_rows` array for pre-fix rows.
  const proposedKbRows = isProposedKbRows(pr)
    ? pr.rows
    : (pr['proposed_kb_rows'] as
        | Array<{ question: string; answer: string; category: string }>
        | undefined)
  if (Array.isArray(proposedKbRows) && proposedKbRows.length > 0) {
    const rows = proposedKbRows.map((r) => ({
      venue_id: auth.venueId,
      question: r.question,
      answer: r.answer,
      category: r.category,
      priority: 50,
      is_active: true,
      source: 'brain_dump_confirmed',
    }))
    // Dedup against existing (venue_id, question) pairs.
    const { data: existing } = await supabase
      .from('knowledge_base')
      .select('question')
      .eq('venue_id', auth.venueId)
      .in('question', rows.map((r) => r.question))
    const existingSet = new Set(((existing ?? []) as Array<{ question: string }>).map((r) => r.question))
    const toInsert = rows.filter((r) => !existingSet.has(r.question))
    let inserted = 0
    if (toInsert.length > 0) {
      const { error: writeErr } = await supabase.from('knowledge_base').insert(toInsert)
      if (writeErr) {
        return NextResponse.json({ error: writeErr.message }, { status: 500 })
      }
      inserted = toInsert.length
    }
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      resolved_at: new Date().toISOString(),
      parse_result: { ...pr, confirmed_at: new Date().toISOString(), inserted, deduped: existingSet.size },
      routed_to: [{ table: 'knowledge_base', id: null, action: `insert:${inserted},deduped:${existingSet.size}` }],
    }).eq('id', id)
    const next = nextHrefFor({ intent: 'knowledge_base_import' })
    return NextResponse.json({
      id,
      status: 'confirmed',
      inserted,
      deduped: existingSet.size,
      nextHref: next?.nextHref ?? null,
      nextLabel: next?.nextLabel ?? null,
    })
  }

  // Case F: proposed operational note → knowledge_gaps row.
  // Bug 11: prefer discriminated narrow; fall back to the legacy
  // `proposed_operational_note` sub-object for pre-fix rows.
  const proposedOpNote = isProposedOperationalNote(pr)
    ? { noteBody: pr.noteBody }
    : (pr['proposed_operational_note'] as { noteBody?: string } | undefined)
  if (proposedOpNote?.noteBody) {
    const { data: insertedRow, error: writeErr } = await supabase
      .from('knowledge_gaps')
      .insert({
        venue_id: auth.venueId,
        question: proposedOpNote.noteBody,
        category: 'operational',
        status: 'open',
      })
      .select('id')
      .single()
    if (writeErr) {
      return NextResponse.json({ error: writeErr.message }, { status: 500 })
    }
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      resolved_at: new Date().toISOString(),
      parse_result: { ...pr, confirmed_at: new Date().toISOString() },
      routed_to: [{ table: 'knowledge_gaps', id: insertedRow.id, action: 'insert' }],
    }).eq('id', id)
    const next = nextHrefFor({ intent: 'operational_note' })
    return NextResponse.json({
      id,
      status: 'confirmed',
      knowledge_gap_id: insertedRow.id,
      nextHref: next?.nextHref ?? null,
      nextLabel: next?.nextLabel ?? null,
    })
  }

  // Case H: proposed staff observation. Bug 1 fix (2026-05-09).
  // routeBrainDump used to write the admin_notification directly with
  // no coordinator review, violating INV-20.5.4-A. Now the propose
  // path parks a proposed_staff_observation payload and we run the
  // staff lookup + notification insert here on confirm.
  const proposedStaff = pr['proposed_staff_observation'] as
    | { kind?: string; staffName?: string; noteBody?: string }
    | undefined
  if (proposedStaff?.kind === 'staff_observation' && proposedStaff.staffName && proposedStaff.noteBody) {
    const trimmed = proposedStaff.staffName.trim()
    const { data: match } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name')
      .eq('venue_id', auth.venueId)
      .or(`first_name.ilike.%${trimmed}%,last_name.ilike.%${trimmed}%`)
      .limit(1)
      .maybeSingle()
    await createNotification({
      venueId: auth.venueId,
      type: 'staff_observation',
      title: match ? `Note on ${match.first_name ?? trimmed}` : `Staff observation: ${trimmed}`,
      body: proposedStaff.noteBody,
    })
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      resolved_at: new Date().toISOString(),
      parse_result: { ...pr, confirmed_at: new Date().toISOString(), staff_match_id: match?.id ?? null },
      routed_to: [{
        table: 'admin_notifications',
        id: null,
        action: `staff_observation:${match?.id ?? 'unresolved'}`,
      }],
    }).eq('id', id)
    const next = nextHrefFor({ intent: 'staff_observation' })
    return NextResponse.json({
      id,
      status: 'confirmed',
      staffMatchId: match?.id ?? null,
      nextHref: next?.nextHref ?? null,
      nextLabel: next?.nextLabel ?? null,
    })
  }

  // Case I: proposed analytics spend rows. Bug 2 fix (2026-05-09).
  // routeBrainDump's analytics branch parks an `extractedSpendRows`
  // array on parse_result for coordinator confirmation, but pre-fix
  // there was no handler here — confirm fell through to Case G's plain
  // stamp and the rows never reached marketing_spend. Mirror the
  // pattern used by the storefront-analytics vision flow: upsert via
  // the existing marketing-spend service so dedup-by-(venue, source,
  // month) is preserved.
  const proposedSpend = pr['extractedSpendRows'] as
    | Array<{ source?: string; month?: string; amount?: number; campaign?: string | null; notes?: string | null }>
    | undefined
  if (Array.isArray(proposedSpend) && proposedSpend.length > 0) {
    const rows: SpendRow[] = []
    for (const r of proposedSpend) {
      if (
        r &&
        typeof r.source === 'string' &&
        typeof r.month === 'string' &&
        typeof r.amount === 'number' &&
        Number.isFinite(r.amount)
      ) {
        rows.push({
          source: r.source,
          month: r.month,
          amount: r.amount,
          campaign: typeof r.campaign === 'string' ? r.campaign : null,
          notes: typeof r.notes === 'string' ? r.notes : null,
        })
      }
    }
    const summary = await upsertSpendRows({
      venueId: auth.venueId,
      rows,
      provenance: 'brain_dump_text',
    })
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      resolved_at: new Date().toISOString(),
      parse_result: { ...pr, confirmed_at: new Date().toISOString(), import_summary: summary },
      routed_to: [{
        table: 'marketing_spend',
        id: null,
        action: `insert:${summary.inserted},update:${summary.updated},skipped:${summary.skipped}`,
      }],
    }).eq('id', id)
    const next = nextHrefFor({ intent: 'analytics' })
    return NextResponse.json({
      id,
      status: 'confirmed',
      importSummary: summary,
      nextHref: next?.nextHref ?? null,
      nextLabel: next?.nextLabel ?? null,
    })
  }

  // Case J: PDF preview confirm. Bug surfaced 2026-05-09 (Isadora's
  // 43-page LINDY EMAIL TRIAGE SHEET): the route parked the extracted
  // text and the bubble said "Confirm to file via the standard
  // classifier" — but no Case existed to actually run the classifier
  // on confirm, so confirms fell through to Case G and the entry's
  // `routed_to` stayed []. The full PDF text sat in
  // parse_result.pdf.extractedText doing nothing.
  //
  // The fix: detect CSV-shape from the extracted text first (tabular
  // PDFs are usually exported spreadsheets — Lindy triage, vendor
  // pricing tables, payment schedules). When CSV-detection succeeds,
  // route through the same runCsvImport path small CSVs use.
  // Otherwise fall through to the regular text classifier so free-
  // text PDFs (brochures, contracts) still route correctly.
  const isPdfPreviewLegacy =
    !prKind &&
    pr.pdf &&
    typeof pr.pdf === 'object' &&
    typeof (pr.pdf as { extractedText?: unknown }).extractedText === 'string'
  if (isPdfPreview(pr) || isPdfPreviewLegacy) {
    // The discriminated `kind: 'pdf_preview'` shape has the fields at
    // the top level; the legacy shape nests them under pr.pdf. Read
    // both forms safely.
    const prAny = pr as Record<string, unknown>
    const pdfShape = (prAny.pdf as Record<string, unknown> | undefined) ?? prAny
    const extractedText = String((pdfShape as { extractedText?: unknown }).extractedText ?? '')

    // Try CSV-shape detection first. We split on the first newline,
    // tokenize the candidate header on whitespace + tabs + pipes
    // (PDFs lose the comma delimiter when re-extracted as text), and
    // only proceed when the header tokens actually match a known
    // CSV-import shape. A header that doesn't match degrades to the
    // text classifier path.
    const firstLineEnd = extractedText.indexOf('\n')
    const candidateHeader =
      firstLineEnd > 0 ? extractedText.slice(0, firstLineEnd) : extractedText.slice(0, 400)
    const headerTokens = candidateHeader
      .split(/\t|\||\s{2,}/)
      .map((s) => s.trim())
      .filter(Boolean)
    const detection = detectCsvShape(headerTokens)

    if (detection.shape !== 'unknown' && detection.confidence >= 0.5 && headerTokens.length >= 3) {
      // Re-tokenize each subsequent line on the same delimiter.
      const lines = extractedText.split('\n').slice(1)
      const dataRows = lines
        .map((line) => line.split(/\t|\||\s{2,}/).map((c) => c.trim()).filter(Boolean))
        .filter((row) => row.length >= Math.max(2, Math.floor(headerTokens.length / 2)))

      const summary = await runCsvImport({
        supabase,
        venueId: auth.venueId,
        detection,
        headerRow: headerTokens,
        dataRows,
      })

      await supabase.from('brain_dump_entries').update({
        parse_status: 'confirmed',
        clarification_answer: body.answer?.trim() ?? null,
        parse_result: {
          ...pr,
          confirmed_at: new Date().toISOString(),
          summary,
          pdf_route: 'csv_import',
        },
        routed_to: [{ table: 'pdf_csv_import', id: null, action: `${detection.shape}:${summary.inserted ?? 0}`}],
        resolved_at: new Date().toISOString(),
      }).eq('id', id)

      const next = nextHrefFor({ intent: `${detection.shape}_preview` })
      return NextResponse.json({
        id,
        status: 'confirmed',
        importSummary: summary,
        pdfRoute: 'csv_import',
        nextHref: next?.nextHref ?? null,
        nextLabel: next?.nextLabel ?? null,
      })
    }

    // Free-text PDF path: feed the extracted text into the regular
    // text classifier. Re-uses classifyBrainDump + routeBrainDump so
    // the same propose-and-confirm + graduation rules apply.
    const { classifyBrainDump, routeBrainDump } = await import('@/lib/services/brain-dump')
    const parsed = await classifyBrainDump({ venueId: auth.venueId, rawText: extractedText })
    const route = await routeBrainDump({
      venueId: auth.venueId,
      entryId: id,
      submittedBy: null,
      parsed,
      rawText: extractedText,
    })

    await supabase.from('brain_dump_entries').update({
      parse_status: route.needsClarification ? 'needs_clarification' : 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      parse_result: {
        ...pr,
        confirmed_at: new Date().toISOString(),
        text_classifier: { intent: parsed.intent, confidence: parsed.confidence },
        pdf_route: 'text_classifier',
      },
      resolved_at: route.needsClarification ? null : new Date().toISOString(),
    }).eq('id', id)

    return NextResponse.json({
      id,
      status: route.needsClarification ? 'needs_clarification' : 'confirmed',
      pdfRoute: 'text_classifier',
      classifierIntent: parsed.intent,
      classifierConfidence: parsed.confidence,
      needsClarification: route.needsClarification,
      clarificationQuestion: route.clarificationQuestion,
      nextHref: route.nextHref ?? null,
      nextLabel: route.nextLabel ?? null,
    })
  }

  // Case G: plain clarification — just stamp the status and the answer.
  const updates: Record<string, unknown> = {
    parse_status: 'confirmed',
    resolved_at: new Date().toISOString(),
  }
  if (body.answer?.trim()) updates.clarification_answer = body.answer.trim()
  await supabase.from('brain_dump_entries').update(updates).eq('id', id)
  return NextResponse.json({ id, status: 'confirmed' })
}
