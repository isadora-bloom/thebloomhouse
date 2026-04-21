-- Add vendor portal fields for self-service + extra fields from Rixey audit
ALTER TABLE booked_vendors ADD COLUMN IF NOT EXISTS portal_token TEXT UNIQUE;
ALTER TABLE booked_vendors ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE booked_vendors ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE booked_vendors ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE booked_vendors ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE booked_vendors ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE booked_vendors ADD COLUMN IF NOT EXISTS arrival_time TEXT;
ALTER TABLE booked_vendors ADD COLUMN IF NOT EXISTS departure_time TEXT;

-- Generate portal tokens for existing vendors (nanoid-style random)
UPDATE booked_vendors
SET portal_token = encode(gen_random_bytes(16), 'hex')
WHERE portal_token IS NULL;
