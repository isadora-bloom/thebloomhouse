-- ============================================
-- 043: EVENT FEEDBACK SYSTEM
-- Post-event coordinator feedback on weddings
-- Depends on: 001_shared_tables.sql, 004_portal_tables.sql
-- ============================================

-- Event Feedback (one per wedding)
CREATE TABLE IF NOT EXISTS event_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  submitted_by uuid REFERENCES user_profiles(id),

  -- Overall Assessment
  overall_rating integer NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  couple_satisfaction integer CHECK (couple_satisfaction BETWEEN 1 AND 5),
  timeline_adherence text CHECK (timeline_adherence IN ('on_time', 'minor_delays', 'significant_delays')),

  -- Timeline Delays
  delay_phases text[] DEFAULT '{}',
  delay_notes text,

  -- Guest Experience
  guest_complaints text,
  guest_complaint_count integer DEFAULT 0,

  -- Catering
  catering_quality integer CHECK (catering_quality BETWEEN 1 AND 5),
  dietary_handling integer CHECK (dietary_handling BETWEEN 1 AND 5),
  service_timing integer CHECK (service_timing BETWEEN 1 AND 5),
  catering_notes text,

  -- Review Readiness
  review_readiness text CHECK (review_readiness IN ('yes', 'no', 'wait')),
  review_readiness_notes text,

  -- Freeform
  what_went_well text,
  what_to_change text,

  -- AI-Assisted Response Draft
  proactive_response_draft text,
  proactive_response_approved boolean DEFAULT false,

  -- Metadata
  feedback_triggered_at timestamptz,
  submitted_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_feedback_venue ON event_feedback(venue_id);
CREATE INDEX IF NOT EXISTS idx_event_feedback_wedding ON event_feedback(wedding_id);
CREATE INDEX IF NOT EXISTS idx_event_feedback_rating ON event_feedback(overall_rating);

-- Unique constraint: one feedback per wedding
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_feedback_wedding_unique ON event_feedback(wedding_id);

-- Event Feedback Vendors (per-vendor ratings within a feedback)
CREATE TABLE IF NOT EXISTS event_feedback_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_feedback_id uuid NOT NULL REFERENCES event_feedback(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES booked_vendors(id) ON DELETE SET NULL,
  vendor_name text NOT NULL,
  vendor_type text NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  notes text,
  would_recommend boolean,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_efv_feedback ON event_feedback_vendors(event_feedback_id);
CREATE INDEX IF NOT EXISTS idx_efv_vendor ON event_feedback_vendors(vendor_id);

-- ---------------------------------------------------------------------------
-- RLS Policies
-- ---------------------------------------------------------------------------

ALTER TABLE event_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_feedback_vendors ENABLE ROW LEVEL SECURITY;

-- Anon can read event_feedback (for demo mode)
CREATE POLICY "anon_read_event_feedback"
  ON event_feedback FOR SELECT TO anon
  USING (true);

-- Anon can insert event_feedback (for demo mode)
CREATE POLICY "anon_insert_event_feedback"
  ON event_feedback FOR INSERT TO anon
  WITH CHECK (true);

-- Anon can update event_feedback (for demo mode)
CREATE POLICY "anon_update_event_feedback"
  ON event_feedback FOR UPDATE TO anon
  USING (true);

-- Authenticated users can read event_feedback (permissive v1 — tighten later)
CREATE POLICY "auth_select_event_feedback"
  ON event_feedback FOR SELECT TO authenticated
  USING (true);

-- Authenticated users can insert event_feedback
CREATE POLICY "auth_insert_event_feedback"
  ON event_feedback FOR INSERT TO authenticated
  WITH CHECK (true);

-- Authenticated users can update event_feedback
CREATE POLICY "auth_update_event_feedback"
  ON event_feedback FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- Authenticated users can delete event_feedback
CREATE POLICY "auth_delete_event_feedback"
  ON event_feedback FOR DELETE TO authenticated
  USING (true);

-- Anon can read event_feedback_vendors (for demo mode)
CREATE POLICY "anon_read_event_feedback_vendors"
  ON event_feedback_vendors FOR SELECT TO anon
  USING (true);

-- Anon can insert event_feedback_vendors (for demo mode)
CREATE POLICY "anon_insert_event_feedback_vendors"
  ON event_feedback_vendors FOR INSERT TO anon
  WITH CHECK (true);

-- Anon can update event_feedback_vendors (for demo mode)
CREATE POLICY "anon_update_event_feedback_vendors"
  ON event_feedback_vendors FOR UPDATE TO anon
  USING (true);

-- Authenticated users can read event_feedback_vendors
CREATE POLICY "auth_select_event_feedback_vendors"
  ON event_feedback_vendors FOR SELECT TO authenticated
  USING (true);

-- Authenticated users can insert event_feedback_vendors
CREATE POLICY "auth_insert_event_feedback_vendors"
  ON event_feedback_vendors FOR INSERT TO authenticated
  WITH CHECK (true);

-- Authenticated users can update event_feedback_vendors
CREATE POLICY "auth_update_event_feedback_vendors"
  ON event_feedback_vendors FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- Authenticated users can delete event_feedback_vendors
CREATE POLICY "auth_delete_event_feedback_vendors"
  ON event_feedback_vendors FOR DELETE TO authenticated
  USING (true);
