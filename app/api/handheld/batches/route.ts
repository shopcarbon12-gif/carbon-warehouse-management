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
  const result = await withDb(async (sql) => {
    const [loc] = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM locations WHERE id = ${location_id}::uuid LIMIT 1
    `;
    if (!loc) return { error: "location_not_found" as const };

    try {
      await sql`
        INSERT INTO handheld_batches (location_id, batch_id, epc_count, status)
        VALUES (${location_id}::uuid, ${batch_id}, ${epcs.length}, 'accepted')
      `;
    } catch {
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM handheld_batches WHERE batch_id = ${batch_id} LIMIT 1
      `;
      if (existing) {
        return {
          ok: true as const,
          duplicate: true,
          accepted: epcs.length,
          batch_id,
        };
      }
      throw new Error("handheld insert failed");
    }

    await enqueueSyncJob(sql, {
      tenantId: loc.tenant_id,
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
