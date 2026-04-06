-- ============================================
-- 017: MISSING TABLES
-- Tables referenced in code but not yet created.
-- Some are new, some fix name mismatches.
-- ============================================

-- Budget items — individual line items in the budget
CREATE TABLE IF NOT EXISTS budget_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  category text NOT NULL,
  item_name text NOT NULL,
  budgeted decimal DEFAULT 0,
  committed decimal DEFAULT 0,
  paid decimal DEFAULT 0,
  payment_source text,
  payment_due_date date,
  vendor_name text,
  notes text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_items_wedding ON budget_items(venue_id, wedding_id);

-- Budget payments — individual payment records per budget item
CREATE TABLE IF NOT EXISTS budget_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_item_id uuid NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  amount decimal NOT NULL,
  payment_date date,
  payment_method text,
  notes text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_payments_item ON budget_payments(budget_item_id);

-- Wedding config — per-wedding settings (budget total, share toggle, meal mode, etc.)
CREATE TABLE IF NOT EXISTS wedding_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  total_budget decimal DEFAULT 0,
  budget_shared boolean DEFAULT false,
  plated_meal boolean DEFAULT false,
  custom_categories jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
CREATE INDEX IF NOT EXISTS idx_wedding_config_wedding ON wedding_config(venue_id, wedding_id);

-- Wedding timeline — stores the full timeline JSON (separate from timeline items)
CREATE TABLE IF NOT EXISTS wedding_timeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  timeline_data jsonb DEFAULT '{}',
  ceremony_start text,
  reception_end text,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
CREATE INDEX IF NOT EXISTS idx_wedding_timeline_wedding ON wedding_timeline(venue_id, wedding_id);

-- Notifications — in-app notifications for coordinators
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  user_id uuid,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_venue ON notifications(venue_id, read);

-- Couple budget — simplified budget summary (used by chat context)
CREATE TABLE IF NOT EXISTS couple_budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  total_budget decimal DEFAULT 0,
  total_committed decimal DEFAULT 0,
  total_paid decimal DEFAULT 0,
  categories jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
