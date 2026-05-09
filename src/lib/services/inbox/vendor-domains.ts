// ---------------------------------------------------------------------------
// inbox/vendor-domains.ts — per-venue vendor-domain allow-list loader.
// ---------------------------------------------------------------------------
//
// Companion to migration 258. Sister of ADVERTISER_DOMAINS in lifecycle.ts
// but venue-scoped: ADVERTISER_DOMAINS is global because cold sales SaaS /
// Knot relays / recruiter spam look the same everywhere, while real
// vendors are per-venue (Rixey's florist isn't Wedgewood's florist).
//
// Hot path: updateThreadLifecycleFolder() loads the venue's allow-list
// once per call and passes the resulting Set into decideLifecycleFolder
// via input.venueVendorDomains. The decider checks the allow-list AFTER
// the explicit role/classifier hits but BEFORE falling to 'other'.
//
// Cache: 5 minute TTL per venue. Invalidated on writes (manual add/remove,
// auto-promotion). Mirrors the pattern in inbox-filters.ts.
// ---------------------------------------------------------------------------

import { createServiceClient } from '@/lib/supabase/service'

interface CachedDomains {
  /** Lower-cased domains, ready for direct Set lookups + suffix matching. */
  domains: Set<string>
  loadedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const cache = new Map<string, CachedDomains>()

/** Drop one venue from the cache, or clear everything when no id given. */
export function clearVendorDomainCache(venueId?: string): void {
  if (venueId) cache.delete(venueId)
  else cache.clear()
}

/**
 * Load and cache the vendor-domain allow-list for a venue. Returns a
 * defensive empty Set on any error so the lifecycle pipeline never
 * crashes on a missing table or RLS denial.
 */
export async function loadVendorDomains(venueId: string): Promise<Set<string>> {
  const cached = cache.get(venueId)
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.domains
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_vendor_domains')
    .select('domain')
    .eq('venue_id', venueId)

  if (error) {
    // Tolerant to a fresh checkout where mig 258 hasn't run yet.
    // Cache the empty set briefly so we don't hammer the DB.
    console.warn('[vendor-domains] load failed:', error.message)
    const empty = new Set<string>()
    cache.set(venueId, { domains: empty, loadedAt: Date.now() })
    return empty
  }

  const domains = new Set<string>()
  for (const row of data ?? []) {
    const d = (row.domain as string | null)?.toLowerCase().trim()
    if (d) domains.add(d)
  }
  cache.set(venueId, { domains, loadedAt: Date.now() })
  return domains
}

/**
 * Same suffix-match semantics as isAdvertiserDomain() in lifecycle.ts —
 * "notifications.gibsonrental.com" matches "gibsonrental.com" via the
 * `.endsWith('.<dom>')` pass.
 *
 * Pure / synchronous so the rule chain can stay allocation-free in the
 * hot path. Callers load the Set once via loadVendorDomains() and pass
 * it in.
 */
export function isVenueVendorDomain(
  domain: string | null | undefined,
  venueDomains: Set<string> | null | undefined,
): boolean {
  if (!domain || !venueDomains || venueDomains.size === 0) return false
  const d = domain.toLowerCase().trim()
  if (!d) return false
  if (venueDomains.has(d)) return true
  for (const dom of venueDomains) {
    if (d.endsWith(`.${dom}`)) return true
  }
  return false
}

/**
 * Idempotent upsert helper used by /api/admin/reclass-folders-ai when
 * Haiku confidently labels a sender domain as 'vendor'. Source defaults
 * to 'ai_classifier'; manual adds from the settings UI pass 'manual'.
 *
 * Returns true on a successful write (insert or confidence bump). The
 * cache for the venue is cleared on success so the next pipeline tick
 * picks up the new entry.
 *
 * Confidence is bumped (never lowered): if the same domain re-promotes
 * with a higher confidence, the row's confidence climbs. If the new
 * promotion is lower, we keep the higher historical value but still
 * touch updated_at.
 */
export async function promoteVendorDomain(args: {
  venueId: string
  domain: string
  confidence: number
  source?: 'ai_classifier' | 'manual' | 'backfill'
  addedBy?: string | null
  note?: string | null
}): Promise<boolean> {
  const venueId = args.venueId
  const domain = args.domain.toLowerCase().trim()
  if (!venueId || !domain) return false
  if (domain.includes('@') || domain.includes(' ')) return false

  const confidence = clampInt(args.confidence, 100, 0, 100)
  const source = args.source ?? 'ai_classifier'

  const supabase = createServiceClient()

  // Read existing row to decide whether to bump confidence or just touch.
  const { data: existing } = await supabase
    .from('venue_vendor_domains')
    .select('id, confidence')
    .eq('venue_id', venueId)
    .eq('domain', domain)
    .maybeSingle()

  const nowIso = new Date().toISOString()
  if (existing) {
    const nextConfidence = Math.max(
      typeof existing.confidence === 'number' ? existing.confidence : 0,
      confidence,
    )
    const { error } = await supabase
      .from('venue_vendor_domains')
      .update({
        confidence: nextConfidence,
        updated_at: nowIso,
      })
      .eq('id', existing.id as string)
    if (error) {
      console.warn('[vendor-domains] update failed:', error.message)
      return false
    }
    clearVendorDomainCache(venueId)
    return true
  }

  const { error } = await supabase.from('venue_vendor_domains').insert({
    venue_id: venueId,
    domain,
    source,
    confidence,
    added_by: args.addedBy ?? null,
    note: args.note ?? null,
  })
  if (error) {
    // Race: a concurrent insert may have just won the unique index.
    // Treat as success since the desired row now exists.
    console.warn('[vendor-domains] insert failed (treating as benign):', error.message)
    clearVendorDomainCache(venueId)
    return false
  }
  clearVendorDomainCache(venueId)
  return true
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}
