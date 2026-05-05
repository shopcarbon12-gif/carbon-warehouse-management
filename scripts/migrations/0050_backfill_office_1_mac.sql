-- 2026-05-05 — backfill the office-1 reader's WIZnet MAC.
--
-- Context: prior to the reader-editor-modal MAC field, manually-added
-- readers had `devices.mac_address = NULL`. The CDM agent's WIZnet discovery
-- sweep matches bridges to devices by MAC, so without a MAC the bridge
-- never bound to the device and kept showing up in the "Discovered WIZnet
-- bridges" panel forever.
--
-- This backfills the one reader the user already added (office-1, .79).
-- Two other observed bridges (.16 and .248) are intentionally left blank —
-- the user is binding those manually via the new MAC field as a smoke test.
--
-- Idempotent: only sets the MAC when it is currently NULL and the network
-- address still matches, so re-running this migration on a tenant that
-- has already touched the row by other means is a no-op.
UPDATE devices
   SET mac_address = '0008dc595740',
       updated_at = now()
 WHERE name = 'office-1'
   AND network_address = '192.168.1.79'
   AND mac_address IS NULL
   AND device_type IN ('fixed_reader','transaction_reader','door_reader');
