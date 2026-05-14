-- ---------------------------------------------------------------------------
-- 345_reviews_column_guard.sql
-- ---------------------------------------------------------------------------
-- Tightens the venue-scoped UPDATE policy from migration 343. That policy
-- gates UPDATE by venue but not by COLUMN — a venue operator could rewrite
-- their own rating / body / review_date and silently re-frame public
-- feedback. We need UPDATE for legitimate response_text / response_date /
-- is_featured / sentiment_score / themes edits made from /intel/reviews,
-- but everything else (the as-received record from Google / Knot / Wedding
-- Wire) is immutable from the operator surface.
--
-- Implementation: BEFORE UPDATE trigger that raises when any "external
-- truth" column is changed by a non-service-role caller. service_role
-- bypasses (ingestion services, paste API, cron). is_super_admin
-- bypasses (cross-venue ops).
--
-- Idempotent: DROP IF EXISTS on both function and trigger.

CREATE OR REPLACE FUNCTION public.reviews_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  -- Ingestion services and paste API use the service_role client.
  -- Cron jobs ditto. Skip the guard for them.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Super admin (cross-venue cleanup work) bypasses.
  IF public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  -- Authenticated venue operator: only response_text, response_date,
  -- is_featured, sentiment_score, themes, updated_at may change.
  -- Everything else is the as-received record and must not be
  -- rewritten from the operator UI.
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'reviews: venue_id is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.source IS DISTINCT FROM NEW.source THEN
    RAISE EXCEPTION 'reviews: source is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.source_review_id IS DISTINCT FROM NEW.source_review_id THEN
    RAISE EXCEPTION 'reviews: source_review_id is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.reviewer_name IS DISTINCT FROM NEW.reviewer_name THEN
    RAISE EXCEPTION 'reviews: reviewer_name is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.rating IS DISTINCT FROM NEW.rating THEN
    RAISE EXCEPTION 'reviews: rating is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.body IS DISTINCT FROM NEW.body THEN
    RAISE EXCEPTION 'reviews: body is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.title IS DISTINCT FROM NEW.title THEN
    RAISE EXCEPTION 'reviews: title is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.review_date IS DISTINCT FROM NEW.review_date THEN
    RAISE EXCEPTION 'reviews: review_date is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'reviews: created_at is immutable (TIER 7+ guard)';
  END IF;
  IF OLD.wedding_id IS DISTINCT FROM NEW.wedding_id THEN
    RAISE EXCEPTION 'reviews: wedding_id is set by reconcileReceivedReviewWithSolicitation only (TIER 7+ guard)';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS reviews_column_guard_trigger ON public.reviews;
CREATE TRIGGER reviews_column_guard_trigger
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.reviews_column_guard();

COMMENT ON FUNCTION public.reviews_column_guard() IS
  'BEFORE UPDATE guard on reviews. Blocks operators from rewriting the '
  'as-received record (venue_id / source / source_review_id / '
  'reviewer_name / rating / body / title / review_date / created_at / '
  'wedding_id). service_role and super_admin bypass. TIER 7+ (2026-05-14).';
