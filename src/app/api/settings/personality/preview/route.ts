import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { buildPersonalityPrompt, buildSignoffBlock, type PersonalityData } from '@/lib/ai/personality-builder'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { callAI } from '@/lib/ai/client'

export const maxDuration = 60

const PREVIEW_PROMPT_VERSION = 'personality-preview.prompt.v1'

/**
 * POST /api/settings/personality/preview
 *
 * Renders a live preview of how the venue's AI assistant would
 * respond to a sample inquiry, using the SAME 4-layer personality
 * engine as the real email-reply path:
 *   - UNIVERSAL_RULES (layer 1)
 *   - buildPersonalityPrompt(...) (layer 2: full venue context, dials,
 *     signoff block, USPs, seasonal content, voice prefs)
 *   - task block (layer 3): the sample inquiry framing
 *   - learning block (layer 4): banned/approved phrases pulled from
 *     voice_preferences when present
 *
 * Critically: the body accepts the IN-FLIGHT working state from the
 * personality page. Coordinator drags a slider, the preview re-renders
 * with the new dials WITHOUT requiring Save. Pre-fix the preview was
 * a hardcoded string-template that did not exercise the real engine,
 * so coordinators could not see what the actual Sage would write
 * with their settings until they saved + sent a real email.
 */

interface PreviewBody {
  // Working PersonalityConfig (matches venue_ai_config schema). All
  // optional so partial drafts work — missing fields fall back to
  // saved row.
  config?: Record<string, unknown>
  // Sample inquiry override — defaults to a generic "wedding inquiry
  // for next summer" if not provided.
  sample?: {
    fromName?: string
    subject?: string
    body?: string
  }
}

const DEFAULT_SAMPLE = {
  fromName: 'Sarah',
  subject: 'Wedding Inquiry - June 2027',
  body: `Hi! My fiance and I are getting married next June and we love what we've seen of your venue online. We're hoping for around 120 guests, an outdoor ceremony, and a more relaxed, garden-party feel. Could you share availability and pricing? Looking forward to hearing back.`,
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('no venue scope on session')

  const body = (await req.json().catch(() => ({}))) as PreviewBody
  const venueId = auth.venueId

  const supabase = createServiceClient()

  // Load the saved venue context. The submitted config (in body)
  // overlays this so unsaved changes preview correctly.
  const [aiConfigRes, venueRes, venueConfigRes, uspsRes, seasonalRes, voiceRes] = await Promise.all([
    supabase.from('venue_ai_config').select('*').eq('venue_id', venueId).single(),
    supabase.from('venues').select('name').eq('id', venueId).single(),
    supabase
      .from('venue_config')
      .select('business_name, coordinator_name, coordinator_phone, coordinator_email, calendly_link')
      .eq('venue_id', venueId)
      .single(),
    supabase.from('venue_usps').select('usp_text').eq('venue_id', venueId).eq('is_active', true).order('sort_order'),
    supabase.from('venue_seasonal_content').select('season, imagery, phrases').eq('venue_id', venueId),
    supabase.from('voice_preferences').select('preference_type, content, score').eq('venue_id', venueId),
  ])

  // Overlay the in-flight body config on top of the saved row so the
  // preview reflects unsaved changes. The page POSTs the full working
  // state on slider drag (debounced).
  const savedConfig = (aiConfigRes.data ?? {}) as Record<string, unknown>
  const overlay = body.config ?? {}
  const aiConfig = { ...savedConfig, ...overlay }

  const venue = venueRes.data
  const venueConfig = (venueConfigRes.data ?? {}) as Record<string, unknown>
  const usps = (uspsRes.data ?? []).map((r) => r.usp_text as string)

  const seasonal: Record<string, { imagery?: string[]; phrases?: string[] }> = {}
  for (const row of seasonalRes.data ?? []) {
    const s = row.season as string
    seasonal[s] = {
      imagery: row.imagery ? [row.imagery as string] : undefined,
      phrases: (row.phrases as string[]) ?? undefined,
    }
  }

  const bannedPhrases: string[] = []
  const approvedPhrases: string[] = []
  const dimensions: Record<string, number> = {}
  for (const pref of voiceRes.data ?? []) {
    const t = pref.preference_type as string
    const c = pref.content as string
    const s = (pref.score as number) ?? 0
    if (t === 'banned_phrase') bannedPhrases.push(c)
    else if (t === 'approved_phrase') approvedPhrases.push(c)
    else if (t === 'dimension') dimensions[c] = s
  }

  const aiName = ((aiConfig.ai_name as string | null | undefined) ?? '').trim()
  if (!aiName) {
    return NextResponse.json(
      { error: 'AI name is required to render a preview. Set the AI Name field above.' },
      { status: 400 },
    )
  }

  const venueName = (venue?.name as string) ?? 'the venue'
  const signoff = buildSignoffBlock({
    aiName,
    aiEmoji: (aiConfig.ai_emoji as string) ?? '',
    aiRoleTitle: (aiConfig.ai_role_title as string | null) ?? null,
    venueName,
    signatureTagline: (aiConfig.signature_tagline as string | null) ?? null,
    signatureWebsite: (aiConfig.signature_website as string | null) ?? null,
    signaturePhone:
      ((aiConfig.signature_phone as string | null) ?? null) ||
      ((venueConfig.coordinator_phone as string | null) ?? null),
    signatureCloser: (aiConfig.signature_closer as string | null) ?? null,
    signatureTextCapable: (aiConfig.signature_text_capable as boolean | null) ?? false,
  })

  const personalityData: PersonalityData = {
    config: aiConfig as PersonalityData['config'],
    venue: { name: venueName },
    venue_config: {
      business_name: (venueConfig.business_name as string) ?? undefined,
      coordinator_phone: (venueConfig.coordinator_phone as string) ?? undefined,
      coordinator_email: (venueConfig.coordinator_email as string) ?? undefined,
    },
    owner_name:
      (aiConfig.owner_name as string | undefined) ??
      (venueConfig.coordinator_name as string | undefined),
    usps,
    seasonal,
    signoff,
    voice_preferences:
      bannedPhrases.length > 0 || approvedPhrases.length > 0 || Object.keys(dimensions).length > 0
        ? { banned_phrases: bannedPhrases, approved_phrases: approvedPhrases, dimensions }
        : undefined,
  }

  const personalityPrompt = buildPersonalityPrompt(personalityData)

  const sample = { ...DEFAULT_SAMPLE, ...(body.sample ?? {}) }

  const taskPrompt = `## TASK: PREVIEW INITIAL INQUIRY REPLY

You are drafting an initial reply to a wedding inquiry. This is a PREVIEW of how you would respond with the current personality settings — so the coordinator can see what their dials produce.

### Inquiry
From: ${sample.fromName}
Subject: ${sample.subject}
Body:
"""
${sample.body}
"""

### Hard rules
- Length: 4 to 7 sentences. Punchy enough to read at a glance.
- Open with the configured greeting; reference one specific detail from the inquiry (the season, guest count, or vibe they mentioned).
- Introduce yourself by name on the FIRST email if introducing-self is part of your personality.
- Close with the configured closer.
- Do NOT use em dashes. Use commas, periods, or hyphens.
- Output ONLY the email body. No "Here is your preview:" preamble. No surrounding quotes.`

  const learningBlock =
    bannedPhrases.length > 0 || approvedPhrases.length > 0
      ? `\n\n## LEARNING FROM PAST FEEDBACK\n${
          bannedPhrases.length > 0
            ? `### Banned Phrases\nNEVER use these phrases: ${bannedPhrases.join(', ')}\n\n`
            : ''
        }${
          approvedPhrases.length > 0
            ? `### Approved Phrases\nFeel free to use these phrases naturally: ${approvedPhrases.join(', ')}`
            : ''
        }`
      : ''

  const systemPrompt = `${UNIVERSAL_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${learningBlock}`

  try {
    const result = await callAI({
      systemPrompt,
      userPrompt: `Draft the preview reply to ${sample.fromName} now.`,
      maxTokens: 600,
      temperature: 0.6,
      venueId,
      taskType: 'personality_preview',
      contentTier: 2,
      tier: 'sonnet',
      promptVersion: PREVIEW_PROMPT_VERSION,
    })

    const draft = (result.text ?? '').trim().replace(/^["']|["']$/g, '')
    if (!draft) {
      return NextResponse.json({ error: 'empty preview' }, { status: 502 })
    }

    return NextResponse.json({
      ok: true,
      draft,
      ai_name: aiName,
      prompt_version: PREVIEW_PROMPT_VERSION,
    })
  } catch (err) {
    return serverError(err)
  }
}
