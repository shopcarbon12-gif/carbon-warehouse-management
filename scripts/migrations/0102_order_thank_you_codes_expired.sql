-- Thank-you codes are expired at once when their order is cancelled
-- (orders/cancelled webhook): ends_at is moved to the cancel time and the
-- reason recorded here. Carbon Rewards already hides rows past ends_at.
ALTER TABLE order_thank_you_codes ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
ALTER TABLE order_thank_you_codes ADD COLUMN IF NOT EXISTS expired_reason TEXT;
