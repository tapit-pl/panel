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
