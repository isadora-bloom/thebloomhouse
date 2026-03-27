-- ============================================
-- 004: PORTAL-OWNED TABLES
-- Owner: portal (couple-facing planning tools, Sage chat, messaging)
-- Depends on: 001_shared_tables.sql
-- ============================================

-- Guest List
CREATE TABLE guest_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  group_name text,
  rsvp_status text DEFAULT 'pending' CHECK (rsvp_status IN ('pending', 'attending', 'declined', 'maybe')),
  meal_preference text,
  dietary_restrictions text,
  plus_one boolean DEFAULT false,
  plus_one_name text,
  table_assignment_id uuid,
  care_notes text,
  invitation_sent boolean DEFAULT false,
  rsvp_responded_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE guest_list IS 'owner:portal';

-- Timeline
CREATE TABLE timeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  time time,
  duration_minutes integer,
  title text NOT NULL,
  description text,
  category text,
  location text,
  vendor_id uuid,
  sort_order integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE timeline IS 'owner:portal';

-- Budget
CREATE TABLE budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  category text,
  item_name text NOT NULL,
  estimated_cost decimal,
  actual_cost decimal,
  paid_amount decimal,
  vendor_id uuid,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE budget IS 'owner:portal';

-- Seating Tables
CREATE TABLE seating_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  table_name text,
  table_type text CHECK (table_type IN ('round', 'rectangle', 'head')),
  capacity integer,
  x_position float,
  y_position float,
  rotation float DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE seating_tables IS 'owner:portal';

-- Seating Assignments
CREATE TABLE seating_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id uuid NOT NULL REFERENCES guest_list(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES seating_tables(id) ON DELETE CASCADE,
  seat_number integer,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE seating_assignments IS 'owner:portal';

-- Now add the FK from guest_list.table_assignment_id to seating_tables
ALTER TABLE guest_list
  ADD CONSTRAINT fk_guest_list_table_assignment
  FOREIGN KEY (table_assignment_id) REFERENCES seating_tables(id) ON DELETE SET NULL;

-- Sage Conversations
CREATE TABLE sage_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  model_used text,
  tokens_used integer,
  cost decimal,
  confidence_score integer,
  flagged_uncertain boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE sage_conversations IS 'owner:portal';

-- Sage Uncertain Queue
CREATE TABLE sage_uncertain_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES sage_conversations(id) ON DELETE SET NULL,
  question text NOT NULL,
  sage_answer text,
  confidence_score integer,
  coordinator_response text,
  resolved_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  added_to_kb boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE sage_uncertain_queue IS 'owner:portal';

-- Planning Notes — extracted from chat messages
CREATE TABLE planning_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  category text CHECK (category IN ('vendor', 'guest_count', 'decor', 'checklist')),
  content text NOT NULL,
  source_message text,
  status text DEFAULT 'extracted',
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE planning_notes IS 'owner:portal';

-- Contracts — uploaded documents
CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  filename text NOT NULL,
  file_type text,
  extracted_text text,
  storage_path text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE contracts IS 'owner:portal';

-- Checklist Items
CREATE TABLE checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  due_date date,
  category text,
  is_completed boolean DEFAULT false,
  completed_at timestamptz,
  sort_order integer,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE checklist_items IS 'owner:portal';

-- Messages — coordinator-couple DMs
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  sender_role text,
  content text NOT NULL,
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE messages IS 'owner:portal';

-- Vendor Recommendations — venue-suggested vendors
CREATE TABLE vendor_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  vendor_name text NOT NULL,
  vendor_type text,
  contact_email text,
  contact_phone text,
  website_url text,
  description text,
  logo_url text,
  is_preferred boolean DEFAULT false,
  sort_order integer,
  click_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE vendor_recommendations IS 'owner:portal';

-- Inspo Gallery — inspiration images
CREATE TABLE inspo_gallery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  image_url text NOT NULL,
  caption text,
  tags text[],
  uploaded_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE inspo_gallery IS 'owner:portal';

-- ============================================
-- INDEXES
-- ============================================

-- guest_list
CREATE INDEX idx_guest_list_venue_id ON guest_list(venue_id);
CREATE INDEX idx_guest_list_wedding_id ON guest_list(wedding_id);
CREATE INDEX idx_guest_list_rsvp_status ON guest_list(wedding_id, rsvp_status);

-- timeline
CREATE INDEX idx_timeline_venue_id ON timeline(venue_id);
CREATE INDEX idx_timeline_wedding_id ON timeline(wedding_id);

-- budget
CREATE INDEX idx_budget_venue_id ON budget(venue_id);
CREATE INDEX idx_budget_wedding_id ON budget(wedding_id);

-- seating_tables
CREATE INDEX idx_seating_tables_venue_id ON seating_tables(venue_id);
CREATE INDEX idx_seating_tables_wedding_id ON seating_tables(wedding_id);

-- seating_assignments
CREATE INDEX idx_seating_assignments_venue_id ON seating_assignments(venue_id);
CREATE INDEX idx_seating_assignments_wedding_id ON seating_assignments(wedding_id);
CREATE INDEX idx_seating_assignments_table_id ON seating_assignments(table_id);

-- sage_conversations
CREATE INDEX idx_sage_conversations_venue_id ON sage_conversations(venue_id);
CREATE INDEX idx_sage_conversations_wedding_id ON sage_conversations(wedding_id);

-- sage_uncertain_queue
CREATE INDEX idx_sage_uncertain_queue_venue_id ON sage_uncertain_queue(venue_id);
CREATE INDEX idx_sage_uncertain_queue_wedding_id ON sage_uncertain_queue(wedding_id);

-- planning_notes
CREATE INDEX idx_planning_notes_venue_id ON planning_notes(venue_id);
CREATE INDEX idx_planning_notes_wedding_id ON planning_notes(wedding_id);

-- contracts
CREATE INDEX idx_contracts_venue_id ON contracts(venue_id);
CREATE INDEX idx_contracts_wedding_id ON contracts(wedding_id);

-- checklist_items
CREATE INDEX idx_checklist_items_venue_id ON checklist_items(venue_id);
CREATE INDEX idx_checklist_items_wedding_id ON checklist_items(wedding_id);

-- messages
CREATE INDEX idx_messages_venue_id ON messages(venue_id);
CREATE INDEX idx_messages_wedding_id ON messages(wedding_id);
CREATE INDEX idx_messages_sender_id ON messages(sender_id);

-- vendor_recommendations
CREATE INDEX idx_vendor_recommendations_venue_id ON vendor_recommendations(venue_id);

-- inspo_gallery
CREATE INDEX idx_inspo_gallery_venue_id ON inspo_gallery(venue_id);
CREATE INDEX idx_inspo_gallery_wedding_id ON inspo_gallery(wedding_id);
