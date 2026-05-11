/**
 * Wave 24 — "Ask a different question" endpoint.
 *
 * POST /api/admin/intel/channel-truth/ask
 * body: { question: string }
 *
 * Uses a small Haiku judge to map the operator's free-text question to
 * one of the pre-built ChannelTruthQuestionIds OR refuse. Refusal is
 * preferred over a misleading match.
 *
 * Does NOT compute the answer — returns the matched question_id so the
 * client can fetch /page?venueId=X with that question pre-selected.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { callAI } from '@/lib/ai/client'
import { ALL_QUESTION_IDS, QUESTION_REGISTRY } from '@/lib/services/channel-truth/registry'

export const maxDuration = 30

interface AskBody {
  question?: string
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  let body: AskBody
  try {
    body = (await req.json()) as AskBody
  } catch {
    return badRequest('invalid JSON')
  }
  const question = (body.question ?? '').trim()
  if (question.length < 4) return badRequest('question too short')
  if (question.length > 500) return badRequest('question too long (500 char max)')

  const catalog = ALL_QUESTION_IDS.map(
    (id) => `  - ${id}: ${QUESTION_REGISTRY[id].question_text}`,
  ).join('\n')

  const systemPrompt = `You are Bloom's Channel Truth question router.

Given an operator's free-text question about their channel attribution
data, map it to one of the pre-built questions below or REFUSE.

PRE-BUILT QUESTIONS:
${catalog}

RULES:
  - Output ONLY JSON: { "question_id": "<id>", "refusal_reason": null } OR
    { "question_id": null, "refusal_reason": "<reason>" }.
  - REFUSE when no pre-built question matches the intent within
    reasonable semantic distance. A misleading match is worse than a
    refusal.
  - REFUSE when the question asks for predictive / future-state
    information ("will Knot work next year?") — Wave 24 narrates
    measured outcomes only.
  - Never invent a question_id outside the catalog.`

  const userPrompt = `Operator question:
"${question}"

Map to one of the catalog ids or refuse.`

  try {
    const result = await callAI({
      systemPrompt,
      userPrompt,
      tier: 'haiku',
      taskType: 'channel_truth_ask',
      contentTier: 4,
      promptVersion: 'channel-truth-ask-judge.prompt.v1',
      venueId: auth.venueId ?? undefined,
      maxTokens: 200,
      temperature: 0,
    })
    const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned) as {
      question_id?: string | null
      refusal_reason?: string | null
    }
    if (parsed.question_id && !ALL_QUESTION_IDS.includes(parsed.question_id as never)) {
      // Hallucinated id — refuse.
      return NextResponse.json({
        ok: true,
        question_id: null,
        refusal_reason: 'I don\'t have a deterministic answer for that yet.',
      })
    }
    return NextResponse.json({
      ok: true,
      question_id: parsed.question_id ?? null,
      refusal_reason: parsed.refusal_reason ?? null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    )
  }
}
