-- ============================================
-- 025: FOLLOW-UP SEQUENCES
-- Structured follow-up sequences with discrete steps.
-- Replaces the JSONB-steps approach in follow_up_sequence_templates
-- with a proper normalised sequence_steps table.
-- ============================================

-- 1. Main sequences table
CREATE TABLE IF NOT EXISTS follow_up_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  trigger_type text NOT NULL CHECK (trigger_type IN ('post_tour', 'ghosted', 'post_booking', 'pre_event', 'custom')),
  trigger_config jsonb DEFAULT '{}',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

COMMENT ON TABLE follow_up_sequences IS 'owner:agent';

CREATE INDEX IF NOT EXISTS idx_follow_up_sequences_venue_id ON follow_up_sequences(venue_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_sequences_active ON follow_up_sequences(venue_id, is_active);

-- 2. Sequence steps table
CREATE TABLE IF NOT EXISTS sequence_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id uuid NOT NULL REFERENCES follow_up_sequences(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  delay_days integer NOT NULL DEFAULT 0,
  action_type text NOT NULL CHECK (action_type IN ('email', 'task', 'alert')),
  email_subject_template text,
  email_body_template text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

COMMENT ON TABLE sequence_steps IS 'owner:agent';

CREATE INDEX IF NOT EXISTS idx_sequence_steps_sequence_id ON sequence_steps(sequence_id);
CREATE INDEX IF NOT EXISTS idx_sequence_steps_order ON sequence_steps(sequence_id, step_order);

-- 3. RLS — follow_up_sequences
ALTER TABLE follow_up_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON follow_up_sequences
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON follow_up_sequences
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- 4. RLS — sequence_steps (access through parent sequence)
ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON sequence_steps
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM follow_up_sequences fs
      WHERE fs.id = sequence_steps.sequence_id
        AND fs.venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid())
    )
  );

CREATE POLICY "super_admin_bypass" ON sequence_steps
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));
