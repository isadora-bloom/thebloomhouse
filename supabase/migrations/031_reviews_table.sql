-- ============================================
-- 031: REVIEWS TABLE
-- Stores raw third-party reviews (Google, The Knot, Wedding Wire).
-- review_language stays separate as the AI-extracted phrase store.
-- ============================================

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('google', 'the_knot', 'wedding_wire', 'yelp', 'facebook', 'other')),
  source_review_id text,
  reviewer_name text,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title text,
  body text NOT NULL,
  review_date date NOT NULL,
  response_text text,
  response_date date,
  is_featured boolean DEFAULT false,
  sentiment_score double precision,
  themes text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_venue_id ON reviews(venue_id);
CREATE INDEX IF NOT EXISTS idx_reviews_review_date ON reviews(review_date DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);

-- RLS
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_reviews" ON reviews FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_reviews" ON reviews FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_reviews" ON reviews FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_reviews" ON reviews FOR DELETE TO anon USING (true);

CREATE POLICY "authenticated_select_reviews" ON reviews FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_insert_reviews" ON reviews FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "authenticated_update_reviews" ON reviews FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_delete_reviews" ON reviews FOR DELETE TO authenticated USING (true);
