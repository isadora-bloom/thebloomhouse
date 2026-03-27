-- ============================================
-- 007: HELPER FUNCTIONS & TRIGGERS
-- Utility functions used by RLS policies,
-- application code, and automated triggers.
-- ============================================

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- get_venue_id_for_user() — returns the venue_id for the current auth user
CREATE OR REPLACE FUNCTION get_venue_id_for_user()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT venue_id FROM user_profiles WHERE id = auth.uid();
$$;

-- get_org_id_for_user() — returns the org_id for the current auth user
CREATE OR REPLACE FUNCTION get_org_id_for_user()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT org_id FROM user_profiles WHERE id = auth.uid();
$$;

-- is_super_admin() — returns true if the current auth user is a super_admin
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
    AND role = 'super_admin'
  );
$$;

-- ============================================
-- TRIGGER FUNCTION: update_updated_at
-- Sets updated_at = now() on every UPDATE
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================
-- APPLY update_updated_at TRIGGER
-- ============================================

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON venues
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON venue_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON venue_ai_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON weddings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON people
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON knowledge_base
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON guest_list
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON timeline
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON budget
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON marketing_spend
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
