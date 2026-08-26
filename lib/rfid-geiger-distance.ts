/**
 * Geiger distance math — PURE, client-safe (no `pg`, no server imports).
 *
 * Two independent ways to turn a radio observation into feet, in ascending
 * order of trustworthiness:
 *
 *   1. `rssiBucket` / `rssiToFeet` — from a single RSSI sample, using a
 *      log-distance path-loss model. Instant (every read carries RSSI) but
 *      COARSE: tag orientation, denim/metal/water and occlusion all move
 *      RSSI by 10+ dB, which is several feet. Treat the output as a band,
 *      never as a measurement.
 *
 *   2. `estimateDistanceFt` — from a power-ramp observation (the lowest
 *      transmit power at which the tag answered), interpolated through
 *      operator-recorded `cdm_antenna_calibration` points. Slower (~35 s
 *      per ramp) and needs a one-time calibration walk per antenna, but
 *      it is a real measurement of that antenna's own link budget.
 *      `powerArgToFeetDefault` is the uncalibrated stand-in used until
 *      an antenna has 2+ calibration points.
 *
 * powerArg is dBm × 10 throughout, matching MonsoonReader's `--power`
 * argument and `cdm_antenna_calibration.first_read_power_arg` (100..330).
 */

export type RssiBand = {
  /** Human foot range, e.g. "3–8 ft". */
  label: string;
  /** Bar / chip colour. Matches the antenna-test workspace palette. */
  color: string;
  /** 0 = closest. Sort key. */
  order: number;
};

/**
 * Coarse foot band from RSSI. Thresholds are deliberately identical to the
 * antenna-test workspace's bucket so the two surfaces never disagree about
 * the same tag.
 */
export function rssiBucket(rssi: number): RssiBand {
  if (rssi >= -55) return { label: "0–3 ft", color: "#0f9c4f", order: 0 };
  if (rssi >= -65) return { label: "3–8 ft", color: "#3fb35d", order: 1 };
  if (rssi >= -75) return { label: "8–15 ft", color: "#bcbf2c", order: 2 };
  if (rssi >= -85) return { label: "15–25 ft", color: "#dd9b2c", order: 3 };
  if (rssi >= -95) return { label: "25–45 ft", color: "#d57021", order: 4 };
  return { label: "45+ ft", color: "#b53d3d", order: 5 };
}

/**
 * Anchor for the log-distance model: RSSI_ANCHOR_DBM is what a tag at
 * ANCHOR_FT reads. Chosen so the curve passes through the middle of every
 * `rssiBucket` band above (−55→3 ft, −65→5.9, −75→11.4, −85→22.3, −95→45),
 * i.e. the numeric readout and the band label can never contradict.
 */
const ANCHOR_FT = 3;
const RSSI_ANCHOR_DBM = -55;
/** 10 × path-loss exponent. 34 ⇒ n ≈ 3.4, fitted to the band thresholds. */
const PATH_LOSS_DENOM = 34;

/**
 * Single-sample RSSI → feet. Coarse by nature — always render it alongside
 * the band label (or with a ± ), never as a bare precise number.
 */
export function rssiToFeet(rssi: number): number {
  const ft = ANCHOR_FT * Math.pow(10, (RSSI_ANCHOR_DBM - rssi) / PATH_LOSS_DENOM);
  return Math.min(200, Math.max(0.5, ft));
}

/**
 * Fill of a 0..1 signal bar for a given RSSI. −100 dBm (noise floor) → 0,
 * −40 dBm (tag basically on the antenna) → 1.
 */
export function rssiToBarFraction(rssi: number): number {
  return Math.min(1, Math.max(0, (rssi + 100) / 60));
}

/**
 * Uncalibrated power-ramp → feet.
 *
 * Passive UHF tags are forward-link limited: the tag turns on when the
 * power reaching it clears its sensitivity threshold, and that power falls
 * as 1/d², so a doubling of distance costs ~6 dB. Anchored at "33 dBm
 * reaches ~25 ft", which is what these SA-2000 panels actually do in the
 * Orlando aisles.
 *
 * This is a stand-in, NOT a measurement — surface it as an estimate until
 * the antenna has 2+ calibration points.
 */
const DEFAULT_ANCHOR_FT = 25;
const DEFAULT_ANCHOR_DBM = 33;
export function powerArgToFeetDefault(powerArg: number): number {
  const dbm = powerArg / 10;
  const ft = DEFAULT_ANCHOR_FT * Math.pow(10, (dbm - DEFAULT_ANCHOR_DBM) / 20);
  return Math.min(200, Math.max(0.5, ft));
}

export type CalibrationPoint = {
  id: string;
  distanceFt: number;
  firstReadPowerArg: number;
  referenceEpc: string;
  measuredAt: string;
  notes: string | null;
};

export type DistanceEstimate = {
  feet: number | null;
  band: string;
  precision: "exact" | "interp" | "extrap" | "sparse" | "uncalibrated";
};

/**
 * Convert a first-read-power observation (dBm × 10) into estimated feet,
 * piecewise-linearly interpolating the calibration points.
 *
 *   - 0 points: returns null (caller falls back to the heuristic bucket or
 *               `powerArgToFeetDefault`).
 *   - 1 point:  returns "≥X" or "<X" only — single point can't bracket.
 *   - 2+ points: linear interpolation between bracketing points; nearest-
 *               segment extrapolation outside the range.
 *
 * Returned `band` is meant for UI display: "10 ft", "≈12 ft ±3", ">25 ft".
 */
export function estimateDistanceFt(
  points: CalibrationPoint[],
  observedPowerArg: number,
): DistanceEstimate {
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
        precision: "interp",
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

/**
 * What the Locate page actually calls: calibrated feet when the antenna has
 * enough points, otherwise the generic curve flagged as uncalibrated.
 */
export function refineFeet(
  points: CalibrationPoint[],
  observedPowerArg: number,
): DistanceEstimate {
  const calibrated = estimateDistanceFt(points, observedPowerArg);
  if (calibrated.feet !== null) return calibrated;
  const ft = powerArgToFeetDefault(observedPowerArg);
  return {
    feet: ft,
    band: `≈ ${ft.toFixed(1)} ft (uncalibrated)`,
    precision: "uncalibrated",
  };
}
