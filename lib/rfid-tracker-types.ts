/** JSON shapes for RFID EPC tracker API (safe to import from client). */

export type TrackerItemDetail = {
  id: string;
  epc: string;
  serial_number: string;
  status: string;
  created_at: string;
  custom_sku_id: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
  location_id: string;
  location_code: string;
  location_name: string;
  bin_id: string | null;
  bin_code: string | null;
  /** When the system first observed this EPC (initial INSERT). */
  first_scanned_at: string | null;
  /** Free-form source label (handheld android_id, "cycle:LOC/BIN", etc.). */
  source: string | null;
  source_device_label: string | null;
  /** Structured device attribution (UUID FKs). Populated on paths that
   *  resolve the originating handheld / fixed reader. NULL on bulk paths
   *  and pre-migration rows. */
  source_device_id: string | null;
  source_device_name: string | null;
  source_antenna_id: string | null;
  source_antenna_name: string | null;
  /** User who created the item row (commission, encode-claim flows).
   *  NULL for agent-discovered or imported rows. */
  created_by_user_id: string | null;
  created_by_email: string | null;
};

export type TrackerSearchPickRow = {
  epc: string;
  sku: string;
  ls_system_id: string;
  description: string;
  color: string | null;
  size: string | null;
  upc: string | null;
  vendor: string | null;
  status: string;
  location_code: string;
  bin_code: string | null;
  archived: boolean;
};

export type TrackerSearchResult =
  | { mode: "direct"; item: TrackerItemDetail }
  | { mode: "pick"; matches: TrackerSearchPickRow[] };
