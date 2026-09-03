-- Custom packages table for Seller Panel
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS custom_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_name TEXT NOT NULL,
  services JSONB DEFAULT '[]'::jsonb,
  total_net NUMERIC(10,2) DEFAULT 0,
  total_gross NUMERIC(10,2) DEFAULT 0,
  total_margin NUMERIC(10,2) DEFAULT 0,
  guest_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  commission_rate NUMERIC(5,2) DEFAULT 0,
  commission_amount NUMERIC(10,2) DEFAULT 0,
  guest_name TEXT NOT NULL,
  guest_email TEXT,
  guest_phone TEXT,
  pax INTEGER DEFAULT 1,
  date DATE,
  time TEXT,
  meeting_point TEXT,
  notes TEXT,
  payment_method TEXT DEFAULT 'stripe',
  status TEXT DEFAULT 'pending',
  stripe_session_id TEXT,
  stripe_session_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE custom_packages ENABLE ROW LEVEL SECURITY;

-- Admin users can do everything
CREATE POLICY "admin_full_access" ON custom_packages
  FOR ALL USING (
    EXISTS (SELECT 1 FROM admin_users WHERE email = (auth.jwt()->>'email'))
  );
