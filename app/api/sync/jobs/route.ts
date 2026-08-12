import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { withDb } from "@/lib/db";
import { enqueueSyncJob, listSyncJobs } from "@/lib/queries/syncJobs";
import {
  isLightspeedCatalogSyncEnabled,
  LIGHTSPEED_SYNC_DISABLED_MESSAGE,
} from "@/lib/server/lightspeed-sync-flag";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await withDb((sql) => listSyncJobs(sql, session.tid, 100), []);
  return NextResponse.json(rows);
}

const postSchema = z.object({
  jobType: z.enum(["lightspeed_pull", "reconcile"]),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Lightspeed catalog pull is retired as a source (WMS owns the catalog).
  if (parsed.data.jobType === "lightspeed_pull" && !isLightspeedCatalogSyncEnabled()) {
    return NextResponse.json(
      { error: LIGHTSPEED_SYNC_DISABLED_MESSAGE, code: "LS_SYNC_DISABLED" },
      { status: 409 },
    );
  }

  const idempotencyKey = `${parsed.data.jobType}:${session.lid}:${Date.now()}`;
  const result = await withDb(
    (sql) =>
      enqueueSyncJob(sql, {
        tenantId: session.tid,
        locationId: session.lid,
        jobType: parsed.data.jobType,
        idempotencyKey,
        payload: { source: "ui" },
      }),
    null,
  );
  if (!result) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  return NextResponse.json(result);
}
