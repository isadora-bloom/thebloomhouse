-- Migration 333: operator locks + historical identifier pool on
-- couple_identity_profile.
--
-- Step 7 of bloom-identity-resolution-doctrine.md (A1 + A2). Closes
-- two distinct gaps:
--
--   A1 — operator name locks. Today when a coordinator manually
--   corrects a name in the lead detail page, the Wave 4 judge can
--   clobber it on the next nightly re-run if fresh evidence outscores
--   the manual edit's confidence. The pattern mirrors weddings.
--   wedding_date_locked_by_operator / source_locked_by_operator
--   (added in earlier migrations). Lock per-partner because the
--   typical case is "operator confirmed partner1 but partner2 is
--   still ambiguous — let the judge keep working on partner2".
--
--   A2 — historical identifier pool. Every email / phone / name
--   spelling we've observed for a couple, stored as jsonb with
--   source + first_seen + last_seen. Future signals can match
--   against any historical identifier, not just whatever happens to
--   be live in people.email today. Closes the "returning couple
--   under a different phone" / "Knot relay alias → real email"
--   re-engagement case at the source rather than relying on
--   alias_emails patches.
--
-- Idempotent. Statement-level (no transaction wrapper) per
-- feedback_migration_no_transaction_wrapper.md.

-- ---- A1 — operator locks ----
ALTER TABLE couple_identity_profile
  ADD COLUMN IF NOT EXISTS partner1_locked_by_operator boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS partner2_locked_by_operator boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by_user_id uuid;

COMMENT ON COLUMN couple_identity_profile.partner1_locked_by_operator IS
  'When true, Wave 4 judge re-runs MUST NOT overwrite profile.names.partner1 first/last/confidence. Operator-set names win. Cleared by the same UI that sets it. Step 7 A1.';

COMMENT ON COLUMN couple_identity_profile.partner2_locked_by_operator IS
  'Same as partner1_locked_by_operator but for partner2. Independent per-partner so a half-confirmed couple still gets judged on the unlocked side. Step 7 A1.';

-- ---- A2 — historical identifier pool ----
ALTER TABLE couple_identity_profile
  ADD COLUMN IF NOT EXISTS identifiers jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN couple_identity_profile.identifiers IS
  'Historical pool of every identifier (email, phone, name_spelling, social_handle) observed for this couple. Each entry: {type, value, first_seen_at, last_seen_at, source}. The resolver matcher reads from this pool, NOT from live people.email — a returning couple texting from a new phone after their original phone was on file matches via the pool even if people.email has been swapped. Append-only via captureIdentifier(). Step 7 A2.';

-- GIN index for jsonb_path_ops so the matcher can do efficient
-- existence checks against `identifiers @> '[{"value":"foo"}]'`.
CREATE INDEX IF NOT EXISTS idx_couple_identity_profile_identifiers
  ON couple_identity_profile USING gin (identifiers jsonb_path_ops);
