-- ---------------------------------------------------------------------------
-- 409_contract_generation.sql
-- ---------------------------------------------------------------------------
-- W57 (NOVEMBER-PLAN.md, wave 8). Contracts a venue generates inside Bloom
-- from a booked wedding's own package figures, sends to the couple, and
-- then watches for a signature.
--
-- The `contracts` table already exists (migration 004) and already holds
-- what a couple uploads: a filename, a file type, the extracted text, a
-- storage path, and since migration 015 a vendor link plus an AI analysis.
-- Nothing here changes any of that. Generated contracts live in the same
-- table, read by the same coordinator and couple surfaces, and carry the
-- extra columns this migration adds.
--
-- Scope note: this is generation and status tracking. It is not
-- e-signature legal infrastructure. A typed name, a timestamp and the
-- caller's IP are recorded as a record of agreement, which is what the
-- venue asked for. No certificate, no audit-trail PDF, no notary.
--
-- Why `status` is not re-declared and gets no CHECK
-- -------------------------------------------------
-- Migration 015 already added `status text DEFAULT 'uploaded'` and the
-- upload path writes 'uploaded', 'extracted' and 'analyzed' into it. The
-- generated lifecycle (draft / sent / viewed / signed / void) shares that
-- same column, which is what the two surfaces want: one pill, one column,
-- one sort. A CHECK constraint would have to list all eight values and
-- would reject any historical row that carries something else, so the
-- allowed set is enforced in code instead, in
-- src/lib/services/contracts/status.ts, where the transition rules live
-- anyway. `kind` is what tells the two lifecycles apart.
--
-- Row-level security: `contracts` is already venue-scoped by the
-- venue_isolation policy of migration 006, plus the couple-role policy of
-- migration 226 and the demo anon policies of migration 027. Adding
-- columns does not change any of them and this migration deliberately
-- adds no policy. The public signing page does not read the table as the
-- anon role; it goes through a service-role route that looks the row up
-- by a hashed token and returns a narrow projection.
--
-- Rerun safety: every statement is IF NOT EXISTS or CREATE OR REPLACE.
-- No BEGIN/COMMIT (the migration runner wraps statements itself).
-- ---------------------------------------------------------------------------

-- uploaded | generated. Defaults to 'uploaded' so every existing row keeps
-- the meaning it already had without a backfill.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'uploaded';

COMMENT ON COLUMN public.contracts.kind IS
  'uploaded = a file the couple or coordinator added. generated = built by '
  'Bloom from the wedding''s package figures. The status column carries a '
  'different set of values for each; see src/lib/services/contracts/status.ts.';

COMMENT ON COLUMN public.contracts.status IS
  'Uploaded contracts: uploaded | extracted | analyzed. Generated '
  'contracts: draft | sent | viewed | signed | void. Not constrained in '
  'SQL because the two lifecycles share the column; the allowed set and '
  'the transitions are enforced in src/lib/services/contracts/status.ts.';

-- Which template built it. Free text so a venue can keep more than one
-- (a full wedding and an elopement, say) without a lookup table.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS template_key text;

COMMENT ON COLUMN public.contracts.template_key IS
  'Key of the template used, e.g. ''standard''. Null for uploads.';

-- The figures the document was built from, frozen at generation time.
-- The wedding's guest count and balance move; a contract that has been
-- sent must not. Holds { snapshot, template }: the numbers AND the
-- wording used, because re-rendering needs both and a venue editing their
-- template next month must not change what somebody already signed.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS generated_from jsonb;

COMMENT ON COLUMN public.contracts.generated_from IS
  '{ snapshot, template }. The package snapshot used to render this '
  'contract (totals, deposit, guest count, hours, names) plus the '
  'template wording it was rendered with. Frozen at generation so the '
  'signing page shows what was sent. Null for uploads.';

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz;

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS signed_at timestamptz;

COMMENT ON COLUMN public.contracts.sent_at IS
  'When the contract email went out. The real event column for the send; '
  'do not window or display created_at for this.';

COMMENT ON COLUMN public.contracts.viewed_at IS
  'First time the couple opened the signing link.';

COMMENT ON COLUMN public.contracts.signed_at IS
  'When the couple typed their name and agreed.';

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS signed_name text;

COMMENT ON COLUMN public.contracts.signed_name IS
  'The name the couple typed. A record of agreement, not a signature '
  'image and not a legal e-signature certificate.';

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS signed_ip text;

COMMENT ON COLUMN public.contracts.signed_ip IS
  'IP the agreement came from, read from the proxy headers. Best effort.';

-- The signing credential. Holds a sha256 of the token that was emailed,
-- never the token itself, the same way couple_invites.token_hash does
-- (migration 391). Anyone who reads this column still cannot sign.
-- Unique because a lookup by token must land on exactly one row.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS sign_token text;

COMMENT ON COLUMN public.contracts.sign_token IS
  'sha256 (hex) of the single-use signing token that was emailed. The '
  'token itself is never stored. Single use for SIGNING: once the row is '
  'signed the same link still opens the contract read-only.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_sign_token
  ON public.contracts (sign_token)
  WHERE sign_token IS NOT NULL;

-- The coordinator's section lists a wedding's generated contracts newest
-- first; the couple's library lists the whole wedding. Both filter on
-- wedding_id, which migration 004 already indexes, so this partial index
-- exists for the kind filter alone.
CREATE INDEX IF NOT EXISTS idx_contracts_generated
  ON public.contracts (wedding_id, kind)
  WHERE kind = 'generated';
