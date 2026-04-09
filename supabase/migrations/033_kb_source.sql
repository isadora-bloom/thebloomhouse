-- Add source tracking to knowledge_base entries
-- Tracks whether a KB entry was created manually, auto-learned from Sage queue resolution, or imported via CSV.

ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual' CHECK (source IN ('manual', 'auto-learned', 'csv'));

-- updated_at already exists in the original 001 schema, but we use IF NOT EXISTS to be safe on older DBs.
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_knowledge_base_source ON knowledge_base(source);
