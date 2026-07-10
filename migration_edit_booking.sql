-- Migration: booking edit system
-- Run in Supabase SQL Editor

-- 1. Add additional_guests column to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS additional_guests text;

-- 2. Add booking_change_requests table
CREATE TABLE IF NOT EXISTS booking_change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    text REFERENCES bookings(id) ON DELETE CASCADE,
  partner_id    uuid NOT NULL,
  partner_name  text,
  changes       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  admin_comment text,
  created_at    timestamptz DEFAULT now(),
  resolved_at   timestamptz
);

-- Index for fast pending lookup in admin
CREATE INDEX IF NOT EXISTS idx_bcr_status ON booking_change_requests(status);
CREATE INDEX IF NOT EXISTS idx_bcr_booking_id ON booking_change_requests(booking_id);

-- RLS: admin sees all, partner sees only their own
ALTER TABLE booking_change_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all" ON booking_change_requests
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM staff
      WHERE staff.id = auth.uid()
      AND staff.role IN ('admin', 'superadmin')
    )
  );

CREATE POLICY "partner_own" ON booking_change_requests
  FOR SELECT
  USING (partner_id = auth.uid());

CREATE POLICY "partner_insert" ON booking_change_requests
  FOR INSERT
  WITH CHECK (partner_id = auth.uid());
