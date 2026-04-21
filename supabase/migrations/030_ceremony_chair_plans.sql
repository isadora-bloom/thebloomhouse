-- Ceremony chair plan: visual row layout for ceremony seating
CREATE TABLE IF NOT EXISTS ceremony_chair_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wedding_id UUID NOT NULL UNIQUE REFERENCES weddings(id) ON DELETE CASCADE,
  plan JSONB DEFAULT '{"rows": []}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ceremony_chair_plans_wedding ON ceremony_chair_plans(wedding_id);

ALTER TABLE ceremony_chair_plans ENABLE ROW LEVEL SECURITY;

-- Couples can read/write their own plan
CREATE POLICY "couples_read_own_ceremony_plan" ON ceremony_chair_plans
  FOR SELECT USING (
    wedding_id IN (SELECT wedding_id FROM people WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()))
  );
CREATE POLICY "couples_write_own_ceremony_plan" ON ceremony_chair_plans
  FOR INSERT WITH CHECK (
    wedding_id IN (SELECT wedding_id FROM people WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()))
  );
CREATE POLICY "couples_update_own_ceremony_plan" ON ceremony_chair_plans
  FOR UPDATE USING (
    wedding_id IN (SELECT wedding_id FROM people WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()))
  );
-- Service role bypasses RLS for admin access
