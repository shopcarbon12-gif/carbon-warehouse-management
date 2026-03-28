/** Orlando Warehouse 001 — floor zones */
export const WAREHOUSE_ZONES = [
  "1A",
  "1B",
  "1C",
  "2A",
  "2B",
  "3A",
  "3B",
  "4A",
  "4B",
  "5A",
  "5B",
  "6A",
  "6B",
] as const;

export type WarehouseZone = (typeof WAREHOUSE_ZONES)[number];

export const WAREHOUSE = {
  id: "ORL-001",
  name: "Carbon Jeans Orlando Warehouse 001",
  city: "Orlando, FL",
} as const;
