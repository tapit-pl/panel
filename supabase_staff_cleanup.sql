-- Staff table cleanup
-- Run in Supabase SQL Editor AFTER deploying the code changes.
--
-- Step 1: Nullify staff_id in bookings (preserve booking history)
UPDATE bookings SET staff_id = NULL WHERE staff_id IS NOT NULL;

-- Step 2: Drop staff table (CASCADE removes FK constraint from bookings automatically)
DROP TABLE IF EXISTS staff CASCADE;
