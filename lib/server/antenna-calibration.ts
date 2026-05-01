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

export type CalibrationPoint = {
  id: string;
  distanceFt: number;
  firstReadPowerArg: number;
  referenceEpc: string;
  measuredAt: string;
  notes: string | null;
};

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

/**
 * Convert a first-read-power observation (dBm × 10) into estimated feet,
 * piecewise-linearly interpolating the calibration points.
 *
 *   - 0 points: returns null (caller falls back to heuristic bucket).
 *   - 1 point:  returns "≥X" or "<X" only — single point can't bracket.
 *   - 2+ points: linear interpolation between bracketing points; nearest-
 *               segment extrapolation outside the range.
 *
 * Returned `band` is meant for UI display: "10 ft", "≈12 ft ±3", ">25 ft".
 */
export function estimateDistanceFt(
  points: CalibrationPoint[],
  observedPowerArg: number,
): { feet: number | null; band: string; precision: "exact" | "interp" | "extrap" | "sparse" | "uncalibrated" } {
  if (points.length === 0) {
    return { feet: null, band: "—", precision: "uncalibrated" };
  }
  // Sort by power ascending — closer tags need less power to read.
  const pts = [...points].sort((a, b) => a.firstReadPowerArg - b.firstReadPowerArg);

  if (pts.length === 1) {
    const p = pts[0]!;
    if (observedPowerArg <= p.firstReadPowerArg) {
      return {
        feet: p.distanceFt,
        band: `≤ ${p.distanceFt.toFixed(1)} ft`,
        precision: "sparse",
      };
    }
    return {
      feet: p.distanceFt,
      band: `> ${p.distanceFt.toFixed(1)} ft`,
      precision: "sparse",
    };
  }

  // Find bracketing pair.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (observedPowerArg >= a.firstReadPowerArg && observedPowerArg <= b.firstReadPowerArg) {
      const t = (observedPowerArg - a.firstReadPowerArg) /
                Math.max(1, b.firstReadPowerArg - a.firstReadPowerArg);
      const feet = a.distanceFt + t * (b.distanceFt - a.distanceFt);
      // Uncertainty band: half the gap between the two anchors.
      const span = Math.abs(b.distanceFt - a.distanceFt);
      const half = Math.max(1, Math.round(span / 2));
      return {
        feet,
        band: `${feet.toFixed(1)} ft ±${half}`,
        precision: i === 0 || i === pts.length - 2 ? "interp" : "interp",
      };
    }
  }

  // Outside the calibrated range — extrapolate from the nearest segment.
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (observedPowerArg < first.firstReadPowerArg) {
    return {
      feet: first.distanceFt,
      band: `≤ ${first.distanceFt.toFixed(1)} ft (extrap)`,
      precision: "extrap",
    };
  }
  return {
    feet: last.distanceFt,
    band: `> ${last.distanceFt.toFixed(1)} ft (extrap)`,
    precision: "extrap",
  };
}
