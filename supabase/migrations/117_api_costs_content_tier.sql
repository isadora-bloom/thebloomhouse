-- Migration 117: api_costs.content_tier
--
-- Per Playbook OPS-21.3.5:
--   "LLM provider data-retention settings: configured to zero-retention
--    where the provider supports it. Tour transcripts and brain-dump
--    content sent to LLM providers must use the no-retention path."
--
-- Tagging callsites in code with contentTier and persisting it on every
-- api_costs row gives us:
--
--   1. An audit trail showing which calls carried tier-1 PII (tour
--      transcripts, family-context notes, brain-dump per-couple intel).
--   2. A validation surface — any tier-1 row that landed without
--      `service='openai'` `+` zero-retention configured upstream is a
--      compliance gap we can fix with a query.
--   3. A starting point for cost-by-sensitivity reporting (tier-1 calls
--      should be lower volume but higher per-call cost on Opus
--      voice-DNA analysis; tier-2 are most calls).
--
-- Tier semantics (Playbook 21.3.1):
--   1 = Highly sensitive (tour transcripts, family context, payment,
--       contracts, third-party mentions without consent)
--   2 = Sensitive (couple PII — names, emails, phones, dates, etc.)
--   3 = Operational (KB content, marketing material, source attribution)
--   4 = Aggregate / anonymised
--
-- Default 2: most brain calls handle tier-2 PII. The columns below are
-- nullable for backward-compat with rows already in api_costs from
-- before the column existed.

ALTER TABLE api_costs
  ADD COLUMN IF NOT EXISTS content_tier integer
    CHECK (content_tier IS NULL OR content_tier BETWEEN 1 AND 4);

COMMENT ON COLUMN api_costs.content_tier IS
  '1=highly sensitive (transcripts, family context, payment), 2=PII '
  '(default), 3=operational, 4=aggregate. Set per call via callAI '
  'options. Tier 1 calls trigger zero-retention path on providers '
  'that support per-request control (OpenAI store:false). Anthropic '
  'zero-data-retention is account-level — see ops doc.';

CREATE INDEX IF NOT EXISTS idx_api_costs_content_tier
  ON api_costs (content_tier)
  WHERE content_tier = 1;
