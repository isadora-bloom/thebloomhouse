-- ============================================================================
-- Migration 063: Preserve sender identity on interactions directly
-- ============================================================================
--
-- CONTEXT
-- The inbox renders "No sender on record" when an interactions row's
-- person_id is NULL, because the only route to a name/email was via the
-- people join. That fails every time findOrCreateContact() fails — and
-- it was failing silently for every new inquiry because the old code
-- wrote to columns that don't exist (full_name on people, contact_type/
-- contact_value on contacts) and used role='primary' which violates the
-- people.role CHECK constraint.
--
-- The code fix patches findOrCreateContact to use the real schema, but
-- relying on a secondary table to know who sent an email is fragile:
-- any future drift between pipeline code and schema, or any RLS issue
-- on people/contacts, erases sender identity on the inbox.
--
-- This migration adds from_email / from_name / to_email directly to
-- interactions as the source of truth for sender/recipient display.
-- The pipeline writes them on every insert. The inbox falls back to
-- these when the people join returns nothing. person_id remains the
-- canonical link when a matching contact exists.
-- ============================================================================

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS from_email text,
  ADD COLUMN IF NOT EXISTS from_name text,
  ADD COLUMN IF NOT EXISTS to_email text;

-- Backfill from the people join where we can. Historical rows where
-- person_id is NULL and no from_email was captured will stay as
-- "No sender on record"; only a Gmail re-sync can recover those.
UPDATE public.interactions i
SET
  from_email = COALESCE(i.from_email, p.email),
  from_name = COALESCE(
    i.from_name,
    NULLIF(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), '')
  )
FROM public.people p
WHERE i.person_id = p.id
  AND i.direction = 'inbound'
  AND (i.from_email IS NULL OR i.from_name IS NULL);

CREATE INDEX IF NOT EXISTS idx_interactions_from_email ON public.interactions(from_email);

NOTIFY pgrst, 'reload schema';
