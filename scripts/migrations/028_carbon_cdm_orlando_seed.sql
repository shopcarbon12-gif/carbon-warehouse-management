-- v3.0: Carbon CDM seed for Orlando Warehouse (location code '001').
-- Creates the existing physical hardware as the first hierarchy entries.
-- Idempotent: safe to re-run; uses ON CONFLICT and EXISTS guards.
--
-- Hierarchy created:
--   Orlando Warehouse (location code '001')
--     ├─ Zone: Warehouse
--     │    └─ Reader: Transfer Bin (192.168.1.16)
--     │          ├─ Antenna bin 1
--     │          └─ Antenna bin 2
--     └─ Zone: Store (empty placeholder for future readers)
--   Carbon CDM agent: 'orlando-cdm' (placeholder token — regenerate in UI)

-- 1. Zones for Orlando Warehouse
INSERT INTO zones (tenant_id, location_id, name, description)
SELECT t.id, l.id, 'Warehouse', 'Main warehouse storage area'
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
ON CONFLICT (location_id, lower(name)) DO NOTHING;
--> statement-breakpoint
INSERT INTO zones (tenant_id, location_id, name, description)
SELECT t.id, l.id, 'Store', 'Retail store floor (no readers yet)'
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
ON CONFLICT (location_id, lower(name)) DO NOTHING;
--> statement-breakpoint

-- 2. Carbon CDM agent for Orlando (one agent manages the whole location)
INSERT INTO cdm_agents (tenant_id, location_id, name, hostname, api_token_hash, status)
SELECT t.id, l.id, 'orlando-cdm', NULL, 'PLACEHOLDER_REGENERATE_VIA_UI', 'offline'
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
ON CONFLICT (location_id, lower(name)) DO NOTHING;
--> statement-breakpoint

-- 3. Transfer Bin reader (192.168.1.16) — parent for the two antennas
INSERT INTO devices (
  tenant_id, location_id, zone_id, cdm_agent_id,
  device_type, name, network_address, status_online, config
)
SELECT
  t.id, l.id, z.id, a.id,
  'fixed_reader',
  'Transfer Bin',
  '192.168.1.16',
  false,
  jsonb_build_object(
    'model', 'SA-2000',
    'monsoon_serial_port', 10002,
    'stream_port', 30100,
    'control_port', 20100,
    'antenna_count', 2,
    'epc_prefix', 'F0A0B'
  )
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
JOIN zones z ON z.location_id = l.id AND lower(z.name) = 'warehouse'
JOIN cdm_agents a ON a.location_id = l.id AND lower(a.name) = 'orlando-cdm'
WHERE t.slug = 'cj'
  AND NOT EXISTS (
    SELECT 1 FROM devices d
    WHERE d.location_id = l.id AND d.device_type = 'fixed_reader'
      AND d.network_address = '192.168.1.16'
  );
--> statement-breakpoint

-- 4. Antenna bin 1 (child of Transfer Bin reader)
INSERT INTO devices (
  tenant_id, location_id, zone_id, cdm_agent_id, parent_device_id,
  device_type, name, status_online, config
)
SELECT
  t.id, l.id, z.id, a.id, r.id,
  'antenna',
  'Antenna bin 1',
  false,
  jsonb_build_object(
    'antenna_number', 1,
    'transmit_power_dbm', 30.0,
    'enabled', true
  )
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
JOIN zones z ON z.location_id = l.id AND lower(z.name) = 'warehouse'
JOIN cdm_agents a ON a.location_id = l.id AND lower(a.name) = 'orlando-cdm'
JOIN devices r ON r.location_id = l.id AND r.device_type = 'fixed_reader'
              AND r.network_address = '192.168.1.16'
WHERE t.slug = 'cj'
  AND NOT EXISTS (
    SELECT 1 FROM devices d
    WHERE d.parent_device_id = r.id
      AND d.device_type = 'antenna'
      AND (d.config->>'antenna_number')::int = 1
  );
--> statement-breakpoint

-- 5. Antenna bin 2 (child of Transfer Bin reader)
INSERT INTO devices (
  tenant_id, location_id, zone_id, cdm_agent_id, parent_device_id,
  device_type, name, status_online, config
)
SELECT
  t.id, l.id, z.id, a.id, r.id,
  'antenna',
  'Antenna bin 2',
  false,
  jsonb_build_object(
    'antenna_number', 2,
    'transmit_power_dbm', 30.0,
    'enabled', true
  )
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
JOIN zones z ON z.location_id = l.id AND lower(z.name) = 'warehouse'
JOIN cdm_agents a ON a.location_id = l.id AND lower(a.name) = 'orlando-cdm'
JOIN devices r ON r.location_id = l.id AND r.device_type = 'fixed_reader'
              AND r.network_address = '192.168.1.16'
WHERE t.slug = 'cj'
  AND NOT EXISTS (
    SELECT 1 FROM devices d
    WHERE d.parent_device_id = r.id
      AND d.device_type = 'antenna'
      AND (d.config->>'antenna_number')::int = 2
  );
