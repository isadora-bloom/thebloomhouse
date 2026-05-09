/**
 * Shared venue-personality loader (Bloom House).
 *
 * The 4-layer brain stack (UNIVERSAL_RULES + personality + task + context)
 * has historically lived inside `services/brain/inquiry.ts` and
 * `services/brain/client.ts`, both of which copy the same six-query
 * Supabase fan-out + 5-minute in-memory cache. This module centralises
 * that loader so coordinator-facing narrators (briefings, digests,
 * /intel narrations, journey narrative, NLQ) can speak with the same
 * `${aiName}` voice the couple-facing brains use without duplicating
 * the load path a third time.
 *
 * Two entry points:
 *
 *   - `loadPersonalityDataCached(venueId)` — strict; throws if
 *     venue_ai_config.ai_name is missing. Use from couple-facing brains
 *     where a missing brand is a hard configuration error.
 *
 *   - `loadCoordinatorPersonalityData(venueId)` — permissive; returns
 *     a synthetic "your assistant" personality when venue_ai_config is
 *     missing. Coordinator surfaces (anomaly cards, briefing emails,
 *     dashboard tiles) need to render *something* even on demo or
 *     half-onboarded venues, so we don't throw — we degrade gracefully.
 */

import { createServiceClient } from '@/lib/supabase/service'
import {
  buildSignoffBlock,
  requireAiName,
  type PersonalityData,
} from '@/lib/ai/personality-builder'

const personalityCache = new Map<string, { data: PersonalityData; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_SOFT_CAP = 200

function evictExpired(): void {
  const now = Date.now()
  for (const [k, v] of personalityCache) {
    if (now > v.expiresAt) personalityCache.delete(k)
  }
}

/**
 * Load + cache the full personality data for a venue. Mirrors the
 * 6-query fan-out used inside inquiry-brain and client-brain.
 *
 * Throws when `venue_ai_config.ai_name` is missing. Couple-facing
 * brains should call this directly; coordinator narrators that need
 * graceful degradation should use `loadCoordinatorPersonalityData`.
 */
export async function loadPersonalityDataCached(venueId: string): Promise<PersonalityData> {
  const cached = personalityCache.get(venueId)
  if (cached && Date.now() < cached.expiresAt) return cached.data

  const data = await loadPersonalityData(venueId)

  if (personalityCache.size > CACHE_SOFT_CAP) evictExpired()
  personalityCache.set(venueId, { data, expiresAt: Date.now() + CACHE_TTL_MS })
  return data
}

async function loadPersonalityData(venueId: string): Promise<PersonalityData> {
  const supabase = createServiceClient()

  const [
    aiConfigResult,
    venueResult,
    venueConfigResult,
    uspsResult,
    seasonalResult,
    voicePrefsResult,
  ] = await Promise.all([
    supabase
      .from('venue_ai_config')
      .select('*')
      .eq('venue_id', venueId)
      .maybeSingle(),
    supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .maybeSingle(),
    supabase
      .from('venue_config')
      .select('business_name, coordinator_name, coordinator_email, coordinator_phone, calendly_link')
      .eq('venue_id', venueId)
      .maybeSingle(),
    supabase
      .from('venue_usps')
      .select('usp_text')
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    supabase
      .from('venue_seasonal_content')
      .select('season, imagery, phrases')
      .eq('venue_id', venueId),
    supabase
      .from('voice_preferences')
      .select('preference_type, content, score')
      .eq('venue_id', venueId),
  ])

  const aiConfig = (aiConfigResult.data ?? {}) as Record<string, unknown>
  const venue = venueResult.data as { name?: string } | null
  const venueConfig = venueConfigResult.data as
    | {
        business_name?: string
        coordinator_name?: string
        coordinator_email?: string
        coordinator_phone?: string
        calendly_link?: string
      }
    | null
  const usps = (uspsResult.data ?? []).map((r) => r.usp_text as string)

  const seasonal: Record<string, { imagery?: string[]; phrases?: string[] }> = {}
  for (const row of seasonalResult.data ?? []) {
    const s = row.season as string
    seasonal[s] = {
      imagery: row.imagery ? [row.imagery as string] : undefined,
      phrases: (row.phrases as string[]) ?? undefined,
    }
  }

  const bannedPhrases: string[] = []
  const approvedPhrases: string[] = []
  const dimensions: Record<string, number> = {}
  for (const pref of voicePrefsResult.data ?? []) {
    const type = pref.preference_type as string
    const content = pref.content as string
    const score = (pref.score as number) ?? 0
    if (type === 'banned_phrase') bannedPhrases.push(content)
    else if (type === 'approved_phrase') approvedPhrases.push(content)
    else if (type === 'dimension') dimensions[content] = score
  }

  // Required brand-identity gate. Throws if ai_name missing — caller
  // (loadCoordinatorPersonalityData) catches and degrades gracefully.
  const aiName = requireAiName(aiConfig as { ai_name?: string | null }, venueId)
  const aiEmoji = (aiConfig.ai_emoji as string | undefined) ?? ''
  const venueName = (venue?.name as string | undefined) ?? 'the venue'
  const signoff = buildSignoffBlock({
    aiName,
    aiEmoji,
    aiRoleTitle: (aiConfig.ai_role_title as string | null | undefined) ?? null,
    venueName,
    signatureTagline: (aiConfig.signature_tagline as string | null | undefined) ?? null,
    signatureWebsite: (aiConfig.signature_website as string | null | undefined) ?? null,
    signaturePhone:
      ((aiConfig.signature_phone as string | null | undefined) ?? null) ||
      ((venueConfig?.coordinator_phone as string | null | undefined) ?? null),
    signatureCloser: (aiConfig.signature_closer as string | null | undefined) ?? null,
    signatureTextCapable:
      (aiConfig.signature_text_capable as boolean | null | undefined) ?? false,
  })

  return {
    config: aiConfig as PersonalityData['config'],
    venue: { name: venueName },
    venue_config: {
      business_name: venueConfig?.business_name,
      coordinator_phone: venueConfig?.coordinator_phone,
      coordinator_email: venueConfig?.coordinator_email,
    },
    owner_name:
      (aiConfig.owner_name as string | undefined) ??
      venueConfig?.coordinator_name,
    usps,
    seasonal,
    signoff,
    voice_preferences:
      bannedPhrases.length > 0 ||
      approvedPhrases.length > 0 ||
      Object.keys(dimensions).length > 0
        ? {
            banned_phrases: bannedPhrases,
            approved_phrases: approvedPhrases,
            dimensions,
          }
        : undefined,
  }
}

/**
 * Permissive variant for coordinator-facing narrators. When the venue
 * has no `venue_ai_config` row (demo data, half-onboarded venue, or a
 * narrator running cross-venue), we synthesise a generic "your
 * assistant" personality so the prompt assembler can still produce a
 * coherent system prompt rather than throwing mid-cron.
 *
 * Returns the same `PersonalityData` shape so downstream consumers
 * (`buildPersonalityPrompt`) don't have to branch.
 */
export async function loadCoordinatorPersonalityData(
  venueId: string,
): Promise<PersonalityData> {
  try {
    return await loadPersonalityDataCached(venueId)
  } catch {
    // Synthesise a minimal personality so coordinator narrators always
    // have an aiName + voice scaffold. The fallback name "your
    // assistant" matches the prior `loadAiName` fallback every
    // coordinator narrator was using before unification.
    return synthesiseDefaultPersonality(venueId)
  }
}

function synthesiseDefaultPersonality(_venueId: string): PersonalityData {
  const aiName = 'your assistant'
  const venueName = 'the venue'
  const signoff = buildSignoffBlock({
    aiName,
    aiEmoji: '',
    aiRoleTitle: null,
    venueName,
    signatureTagline: null,
    signatureWebsite: null,
    signaturePhone: null,
    signatureCloser: null,
    signatureTextCapable: false,
  })
  return {
    config: { ai_name: aiName },
    venue: { name: venueName },
    venue_config: {},
    owner_name: undefined,
    usps: [],
    seasonal: {},
    signoff,
    voice_preferences: undefined,
  }
}

// Test-only hooks.
export const __test__ = {
  reset(): void {
    personalityCache.clear()
  },
  size(): number {
    return personalityCache.size
  },
}
