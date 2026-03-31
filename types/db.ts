/** Row shapes for RFID / Matrix tables (see `scripts/migrations/002_matrix_architecture.sql` + `003_standardize_lightspeed_terms.sql`). */

export type LocationType = "warehouse" | "retail";

export type ItemStatus =
  | "in-stock"
  | "return"
  | "damaged"
  | "sold"
  | "stolen"
  | "tag_killed"
  | "UNKNOWN"
  | "pending_visibility"
  | "in-transit"
  | "pending_transaction";

export interface LocationRow {
  id: string;
  /** Multi-tenant baseline column (see `scripts/schema.sql`). */
  tenant_id: string;
  code: string;
  name: string;
  type: LocationType;
  lightspeed_location_id: string | null;
  created_at: Date;
}

/** Lightspeed Matrix (parent / UPC). */
export interface MatrixRow {
  id: string;
  upc: string;
  description: string;
  created_at: Date;
}

/** Lightspeed Custom SKU (child of matrix). */
export interface CustomSkuRow {
  id: string;
  matrix_id: string;
  sku: string;
  /** `pg` returns `bigint` as string by default. */
  ls_system_id: string;
  color_code: string | null;
  size: string | null;
  created_at: Date;
}

/** Physical RFID item (EPC) tied to a custom SKU. */
export interface ItemRow {
  id: string;
  /** 24-char hex SGTIN-96 payload (see `lib/utils/epc.ts`). */
  epc: string;
  /** `pg` returns `bigint` as string by default. */
  serial_number: string;
  custom_sku_id: string;
  location_id: string;
  bin_id: string | null;
  status: ItemStatus;
  created_at: Date;
}
