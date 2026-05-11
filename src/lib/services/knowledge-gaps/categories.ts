/**
 * Bloom House — knowledge-gap category enum (F22).
 *
 * Mirrors the CHECK constraint added by migration 298. Lives in the
 * service tree so the cron backfill, the capture route, and the
 * detector all import the same source-of-truth list. Adding a new
 * category here AND in mig 298 (or its successor) is a coordinated
 * migration.
 */
export const KNOWLEDGE_GAP_CATEGORIES = [
  'pricing',
  'availability',
  'logistics',
  'policy',
  'vendor',
  'ceremony',
  'catering',
  'inclusions',
  'other',
] as const

export type KnowledgeGapCategory = (typeof KNOWLEDGE_GAP_CATEGORIES)[number]
