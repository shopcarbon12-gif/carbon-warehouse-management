-- Visitors: hold the "New visitor" / "is back" alert until the visitor has
-- stayed 20 seconds or opened a second page (owner 2026-10-22: a residential-
-- proxy scraper was ringing the doorbell every minute with one-page, few-second
-- visits). pending_alert is the alert waiting to go out for the current visit;
-- visit_started_at is when that visit began.
ALTER TABLE visitors
  ADD COLUMN IF NOT EXISTS pending_alert text,
  ADD COLUMN IF NOT EXISTS visit_started_at timestamptz;
