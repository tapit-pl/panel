-- Run this in Supabase SQL editor to create the tour_commissions table
CREATE TABLE IF NOT EXISTS tour_commissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT DEFAULT '',
  price_pln INTEGER DEFAULT 0,
  commission_pln INTEGER DEFAULT 0,
  tour_config_id UUID REFERENCES tour_config(id) ON DELETE SET NULL,
  active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE tour_commissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_all" ON tour_commissions FOR SELECT TO public USING (true);
CREATE POLICY "write_auth" ON tour_commissions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Settings table (key-value store for admin config)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
-- Only authenticated can read/write settings
CREATE POLICY "read_auth" ON settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_auth" ON settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Default PIN = "1234" (stored as SHA-256 hex hash)
-- To insert/update default PIN:
INSERT INTO settings (key, value)
VALUES ('tours_pin_hash', encode(digest('1234', 'sha256'), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- Verify admin PIN server-side (hash never sent to browser)
CREATE OR REPLACE FUNCTION verify_admin_pin(input_pin TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stored_hash TEXT;
BEGIN
  SELECT value INTO stored_hash FROM settings WHERE key = 'tours_pin_hash';
  IF stored_hash IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN stored_hash = encode(digest(input_pin, 'sha256'), 'hex');
END;
$$;

-- Change admin PIN (requires knowing the current PIN)
CREATE OR REPLACE FUNCTION change_admin_pin(current_pin TEXT, new_pin TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stored_hash TEXT;
BEGIN
  SELECT value INTO stored_hash FROM settings WHERE key = 'tours_pin_hash';
  IF stored_hash IS NULL OR stored_hash != encode(digest(current_pin, 'sha256'), 'hex') THEN
    RETURN FALSE;
  END IF;
  UPDATE settings SET value = encode(digest(new_pin, 'sha256'), 'hex'), updated_at = NOW()
  WHERE key = 'tours_pin_hash';
  RETURN TRUE;
END;
$$;

-- Grant execute on functions to authenticated users
GRANT EXECUTE ON FUNCTION verify_admin_pin(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION change_admin_pin(TEXT, TEXT) TO authenticated;
