/**
 * Size charts (flat measurements, cm) and grading a measured shirt against them.
 */

export const POMS = ["chest", "length", "hem"] as const;
export type Pom = (typeof POMS)[number];

export const POM_LABELS: Record<Pom, string> = {
  chest: "Chest width (flat)",
  length: "Body length",
  hem: "Hem width (flat)",
};

export type SizeSpec = { size: string } & Record<Pom, number>;

export type SizeChart = {
  name: string;
  /** ± allowed deviation per point of measure, cm. */
  tolerance: Record<Pom, number>;
  sizes: SizeSpec[];
};

/** Placeholder chart — a generic regular-fit tee. Replace with Carbon's spec. */
export const SAMPLE_CHART: SizeChart = {
  name: "Sample regular-fit tee (replace with your spec)",
  tolerance: { chest: 1.5, length: 1.5, hem: 1.5 },
  sizes: [
    { size: "XS", chest: 45, length: 68, hem: 45 },
    { size: "S", chest: 48, length: 70, hem: 48 },
    { size: "M", chest: 51, length: 72, hem: 51 },
    { size: "L", chest: 54, length: 74, hem: 54 },
    { size: "XL", chest: 57, length: 76, hem: 57 },
    { size: "XXL", chest: 60, length: 78, hem: 60 },
  ],
};

export type Measured = Record<Pom, number>;

export type SizeFit = {
  size: string;
  /** measured − spec, cm, per POM. */
  diff: Record<Pom, number>;
  inTolerance: Record<Pom, boolean>;
  allInTolerance: boolean;
  /** Sum of squared tolerance-normalised deviations — lower is closer. */
  score: number;
};

export type GradeResult = {
  best: SizeFit | null;
  fits: SizeFit[];
};

export function gradeShirt(measured: Measured, chart: SizeChart): GradeResult {
  const fits = chart.sizes.map((spec): SizeFit => {
    const diff = {} as Record<Pom, number>;
    const inTolerance = {} as Record<Pom, boolean>;
    let score = 0;
    for (const pom of POMS) {
      const d = measured[pom] - spec[pom];
      const tol = chart.tolerance[pom] > 0 ? chart.tolerance[pom] : 1;
      diff[pom] = d;
      inTolerance[pom] = Math.abs(d) <= chart.tolerance[pom];
      score += (d / tol) ** 2;
    }
    return { size: spec.size, diff, inTolerance, allInTolerance: POMS.every((p) => inTolerance[p]), score };
  });
  let best: SizeFit | null = null;
  for (const f of fits) if (!best || f.score < best.score) best = f;
  return { best, fits };
}

/** Parse a stored chart defensively; fall back to the sample chart. */
export function parseChart(raw: string | null): SizeChart {
  if (!raw) return SAMPLE_CHART;
  try {
    const c = JSON.parse(raw) as SizeChart;
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    if (
      typeof c?.name === "string" &&
      POMS.every((p) => num(c.tolerance?.[p])) &&
      Array.isArray(c.sizes) &&
      c.sizes.length > 0 &&
      c.sizes.every((s) => typeof s?.size === "string" && POMS.every((p) => num(s[p])))
    ) {
      return c;
    }
  } catch {
    /* fall through */
  }
  return SAMPLE_CHART;
}
