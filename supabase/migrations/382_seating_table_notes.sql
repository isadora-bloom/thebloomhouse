-- Add per-table coordinator notes + widen table_type to match app types
ALTER TABLE seating_tables
  ADD COLUMN IF NOT EXISTS notes text;

-- Widen table_type CHECK to match all types the seating page uses
ALTER TABLE seating_tables
  DROP CONSTRAINT IF EXISTS seating_tables_table_type_check;

ALTER TABLE seating_tables
  ADD CONSTRAINT seating_tables_table_type_check
  CHECK (table_type IN ('round', 'rectangle', 'rectangular', 'head', 'sweetheart', 'farm', 'cocktail'));
