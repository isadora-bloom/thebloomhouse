/**
 * Wave 24 — Channel Truth share endpoint.
 *
 * POST /api/admin/intel/channel-truth/share
 * body: { questionId: string, format: 'csv' | 'pdf' | 'link' | 'embed' }
 *
 * Returns a snapshot the operator can send externally. For 'csv' the
 * server emits text/csv with the per-cell numbers + sample sizes +
 * prompt versions. For 'pdf' we return a structured JSON that the
 * client can render to PDF (no server-side PDF lib pulled in for Wave
 * 24; can be added in a follow-up).
 *
 * Writes a row to channel_truth_audits with share_format set so the
 * reproducibility ledger captures who shared what + when.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  computeChannelTruthPage,
  writeAuditSnapshot,
} from '@/lib/services/channel-truth/compute-all'
import { createServiceClient } from '@/lib/supabase/service'
import type { ChannelTruthQuestionId, NarratedAnswer } from '@/lib/services/channel-truth/types'

export const maxDuration = 120

interface ShareBody {
  questionId?: string
  format?: string
  venueId?: string
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  let body: ShareBody
  try {
    body = (await req.json()) as ShareBody
  } catch {
    return badRequest('invalid JSON')
  }

  const requestedVenueId = body.venueId
  if (
    requestedVenueId &&
    requestedVenueId !== auth.venueId &&
    auth.role !== 'super_admin'
  ) {
    return forbidden('venue does not belong to caller')
  }
  const venueId = requestedVenueId ?? auth.venueId
  const questionId = body.questionId as ChannelTruthQuestionId | undefined
  const format = body.format

  if (!questionId) return badRequest('questionId required')
  if (!format || !['csv', 'pdf', 'link', 'embed'].includes(format)) {
    return badRequest('format must be csv | pdf | link | embed')
  }

  // Re-compute (cheaply — no narrator) for just this question, then
  // narrate it for the export.
  const payload = await computeChannelTruthPage(venueId, {
    questionIds: [questionId],
  })
  if (!payload.ok) {
    return NextResponse.json({ ok: false, error: payload.error }, { status: 500 })
  }
  const answer = payload.answers[0]
  if (!answer) {
    return NextResponse.json(
      { ok: false, error: 'no answer produced (compute returned empty)' },
      { status: 500 },
    )
  }

  // Write share audit row.
  let auditId: string | null = null
  try {
    const audit = await writeAuditSnapshot({
      venueId,
      viewedBy: auth.isDemo ? null : auth.userId,
      payload,
    })
    auditId = audit.id
    if (auditId) {
      const sb = createServiceClient()
      await sb
        .from('channel_truth_audits')
        .update({
          shared_at: new Date().toISOString(),
          share_format: format,
          shared_question_id: questionId,
        })
        .eq('id', auditId)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[channel-truth] share audit write failed:', err)
  }

  if (format === 'csv') {
    const csv = buildCsv(answer)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="channel-truth-${questionId}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  }

  // pdf/link/embed: return structured JSON. Clients render to PDF or
  // build a deep-link from the audit id.
  return NextResponse.json({
    ok: true,
    audit_id: auditId,
    format,
    snapshot: {
      question_id: answer.question_id,
      question_text: answer.question_text,
      narrator: answer.narrator,
      cells: answer.cells,
      total_sample_size: answer.total_sample_size,
      confidence_level: answer.confidence_level,
      v1_contamination_pct: answer.v1_contamination_pct,
      data_freshness_iso: answer.data_freshness_iso,
      prompt_versions_used: answer.prompt_versions_used,
      compute_signature: answer.compute_signature,
      computed_at_iso: answer.computed_at_iso,
      evidence_weddings: answer.evidence_weddings,
      narrator_prompt_version: answer.narrator_prompt_version,
      calibration: payload.calibration,
    },
  })
}

function buildCsv(answer: NarratedAnswer): string {
  const lines: string[] = []
  lines.push('question_id,question_text')
  lines.push(`"${answer.question_id}","${csvEscape(answer.question_text)}"`)
  lines.push('')
  lines.push('compute_signature,computed_at_iso,confidence_level,total_sample_size,v1_contamination_pct,data_freshness_iso')
  lines.push(
    [
      answer.compute_signature,
      answer.computed_at_iso,
      answer.confidence_level,
      String(answer.total_sample_size),
      answer.v1_contamination_pct.toFixed(2),
      answer.data_freshness_iso,
    ].join(','),
  )
  lines.push('')
  lines.push('headline_pull_quote')
  lines.push(`"${csvEscape(answer.narrator.headline_pull_quote)}"`)
  lines.push('')
  lines.push('narration_paragraph')
  lines.push(`"${csvEscape(answer.narrator.narration_paragraph)}"`)
  lines.push('')
  lines.push('refusal_reason')
  lines.push(`"${csvEscape(answer.narrator.refusal_reason ?? '')}"`)
  lines.push('')
  lines.push('cells')
  lines.push('label,n,headline_value,ci_95_half_width,v1_contaminated_pct')
  for (const c of answer.cells) {
    lines.push(
      [
        csvEscape(c.label),
        String(c.n),
        csvEscape(JSON.stringify(c.headline_value)),
        c.ci_95_half_width === null ? '' : c.ci_95_half_width.toFixed(4),
        c.v1_contaminated_pct.toFixed(2),
      ].join(','),
    )
  }
  lines.push('')
  lines.push('prompt_versions_used')
  for (const pv of answer.prompt_versions_used) lines.push(pv)
  lines.push('')
  lines.push('evidence_wedding_ids')
  for (const ev of answer.evidence_weddings) {
    lines.push(`${ev.wedding_id},${csvEscape(ev.annotation)},${ev.v1_contaminated ? 'v1' : ''}`)
  }
  return lines.join('\n')
}

function csvEscape(s: string): string {
  return s.replace(/"/g, '""')
}
