import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyDeviceKey } from "@/lib/handheld-auth";
import { withDb } from "@/lib/db";
import { enqueueSyncJob } from "@/lib/queries/syncJobs";

const bodySchema = z.object({
  batch_id: z.string().min(1).max(128),
  location_id: z.string().uuid(),
  epcs: z.array(z.string()).min(1).max(5000),
});

export async function POST(req: Request) {
  const key = req.headers.get("x-wms-device-key");
  if (!verifyDeviceKey(key)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { batch_id, location_id, epcs } = parsed.data;
  const result = await withDb(async (pool) => {
    const loc = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM locations WHERE id = $1::uuid LIMIT 1`,
      [location_id],
    );
    const row = loc.rows[0];
    if (!row) return { error: "location_not_found" as const };

    try {
      await pool.query(
        `INSERT INTO handheld_batches (location_id, batch_id, epc_count, status)
         VALUES ($1::uuid, $2, $3, 'accepted')`,
        [location_id, batch_id, epcs.length],
      );
    } catch {
      const ex = await pool.query<{ id: string }>(
        `SELECT id FROM handheld_batches WHERE batch_id = $1 LIMIT 1`,
        [batch_id],
      );
      if (ex.rows[0]) {
        return {
          ok: true as const,
          duplicate: true,
          accepted: epcs.length,
          batch_id,
        };
      }
      throw new Error("handheld insert failed");
    }

    await enqueueSyncJob(pool, {
      tenantId: row.tenant_id,
      locationId: location_id,
      jobType: "handheld_process",
      idempotencyKey: `handheld:${batch_id}`,
      payload: { epcCount: epcs.length },
    });

    return {
      ok: true as const,
      duplicate: false,
      accepted: epcs.length,
      batch_id,
    };
  }, null);

  if (!result) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  if (result.error === "location_not_found") {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }
  return NextResponse.json(result);
}
