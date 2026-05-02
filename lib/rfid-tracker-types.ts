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
