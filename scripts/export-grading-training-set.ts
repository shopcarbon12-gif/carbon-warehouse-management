/**
 * CarbonGradingAI training set: every confirmed scan as an image + keypoints.
 *
 *   npx tsx scripts/export-grading-training-set.ts --out ./grading-dataset [--status approved,saved] [--since 2026-10-13]
 *
 * One image per scan (the squared-up photo the lines were drawn on, from R2)
 * and annotations.json: per scan the garment type, scale, and for every point
 * of measure its end points as the operator left them, plus what the outline
 * and the AI had proposed — the "moved" flag marks the corrections, which are
 * the most valuable examples. Test-phone scans (no depth sensor) are left out.
 * DATABASE_URL and R2_* come from the environment (.env.local / prod tunnel).
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { downloadStorageObject } from "@/lib/storageProvider";

loadEnvConfig(process.cwd());

function arg(name: string, def?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function main() {
  const out = path.resolve(arg("out", "grading-dataset")!);
  const statuses = arg("status", "approved,saved")!.split(",");
  const since = arg("since", "2000-01-01")!;
  fs.mkdirSync(path.join(out, "images"), { recursive: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /sslmode=require/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : false });
  const r = await pool.query(
    `SELECT s.id, s.profile, s.garment_type, s.size, s.px_per_cm, s.photo_key, s.photo_w, s.photo_h, s.lines, s.ai_lines,
            s.outline_lines, s.points_cm, s.depth, s.status, s.created_at, m.description AS product
       FROM size_grading_scans s JOIN matrices m ON m.id = s.matrix_id
      WHERE s.status = ANY($1) AND s.created_at >= $2::date AND s.photo_key IS NOT NULL
        AND COALESCE((s.depth->>'tof')::boolean, false)
      ORDER BY s.created_at`,
    [statuses, since],
  );
  const items: unknown[] = [];
  for (const s of r.rows) {
    const file = `images/${s.id}.jpg`;
    if (!fs.existsSync(path.join(out, file))) {
      const obj = await downloadStorageObject(s.photo_key);
      fs.writeFileSync(path.join(out, file), Buffer.from(obj.body));
    }
    items.push({
      id: s.id, file, width: s.photo_w, height: s.photo_h, profile: s.profile, family: s.garment_type,
      product: s.product, size: s.size, pxPerCm: Number(s.px_per_cm), status: s.status, createdAt: s.created_at,
      points: s.lines, aiProposed: s.ai_lines, outlineProposed: s.outline_lines, cm: s.points_cm, depth: s.depth,
    });
  }
  fs.writeFileSync(path.join(out, "annotations.json"), JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 1));
  const byProfile = new Map<string, number>();
  for (const s of r.rows) byProfile.set(s.profile, (byProfile.get(s.profile) ?? 0) + 1);
  console.log(`${items.length} scans → ${out}`, Object.fromEntries(byProfile));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
