/**
 * Antenna calibration: per-(reader, antenna) lookup table that converts a
 * "first-read-power" observation into measured feet.
 *
 * Operator flow:
 *   1. Place a known reference tag at distance D feet from the antenna.
 *   2. Run a power sweep against that antenna (the same sweep mode the
 *      live-scan page already supports), so each EPC accumulates a
 *      first-read-power value.
 *   3. Pick the row that matches the reference tag, click "Save as
 *      calibration point at D ft" — calls saveCalibrationPoint() below.
 *   4. Repeat at 5, 10, 15, 20 ft. With 3+ points, the live-scan page
 *      stops using the heuristic distance bucket and starts interpolating
 *      real feet from any subsequent first-read-power observation.
 *
 * Storage: cdm_antenna_calibration (migration 038).
 */

import type { Pool } from "pg";

// The point shape and the power→feet interpolation are pure and shared with
// the client (Tags & Labels → Locate Tag), so they live in a client-safe
// module. Re-exported here so existing server importers keep working.
export type { CalibrationPoint } from "@/lib/rfid-geiger-distance";
export { estimateDistanceFt } from "@/lib/rfid-geiger-distance";

import type { CalibrationPoint } from "@/lib/rfid-geiger-distance";

export async function listCalibrationPoints(
  pool: Pool,
  tenantId: string,
  readerId: string,
  antennaId: string,
): Promise<CalibrationPoint[]> {
  const r = await pool.query<{
    id: string;
    distance_ft: string;
    first_read_power_arg: number;
    reference_epc: string;
    measured_at: Date;
    notes: string | null;
  }>(
    `SELECT id::text, distance_ft::text, first_read_power_arg, reference_epc,
            measured_at, notes
       FROM cdm_antenna_calibration
       WHERE tenant_id = $1::uuid AND reader_id = $2::uuid AND antenna_id = $3::uuid
       ORDER BY distance_ft ASC`,
    [tenantId, readerId, antennaId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    distanceFt: Number(row.distance_ft),
    firstReadPowerArg: row.first_read_power_arg,
    referenceEpc: row.reference_epc,
    measuredAt: row.measured_at.toISOString(),
    notes: row.notes,
  }));
}

export async function saveCalibrationPoint(
  pool: Pool,
  input: {
    tenantId: string;
    readerId: string;
    antennaId: string;
    distanceFt: number;
    firstReadPowerArg: number;
    referenceEpc: string;
    measuredBy: string | null;
    notes: string | null;
  },
): Promise<{ id: string }> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO cdm_antenna_calibration
       (tenant_id, reader_id, antenna_id, distance_ft, first_read_power_arg,
        reference_epc, measured_by, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::int,
             $6::text, $7::uuid, $8::text)
     ON CONFLICT (reader_id, antenna_id, distance_ft) DO UPDATE SET
       first_read_power_arg = EXCLUDED.first_read_power_arg,
       reference_epc        = EXCLUDED.reference_epc,
       measured_at          = now(),
       measured_by          = EXCLUDED.measured_by,
       notes                = EXCLUDED.notes
     RETURNING id::text`,
    [
      input.tenantId,
      input.readerId,
      input.antennaId,
      input.distanceFt,
      input.firstReadPowerArg,
      input.referenceEpc.toUpperCase(),
      input.measuredBy,
      input.notes,
    ],
  );
  return { id: r.rows[0]!.id };
}

export async function deleteCalibrationPoint(
  pool: Pool,
  tenantId: string,
  pointId: string,
): Promise<{ deleted: boolean }> {
  const r = await pool.query(
    `DELETE FROM cdm_antenna_calibration WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [pointId, tenantId],
  );
  return { deleted: (r.rowCount ?? 0) > 0 };
}
