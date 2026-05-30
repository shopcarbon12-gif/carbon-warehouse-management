import type { PoolClient } from "pg";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { zeroOutRfidData, type ZeroOutResult } from "@/lib/server/rfid-zero-out";

/**
 * The wipe DELETEs every cdm_reads/items/etc. row for the tenant while the
 * live cdm-agent is INSERTing into those same tables at ~30 rows/s. Even with
 * the in-transaction guards (lock_timeout, replica role) Postgres can detect a
 * lock cycle and kill our transaction with "deadlock detected" (SQLSTATE
 * 40P01). A deadlock is transient by definition — the victim just has to run
 * again — so we retry the whole BEGIN→wipe→COMMIT a few times with backoff.
 * 40001 (serialization_failure) is retried for the same reason.
 */
const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);
const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runZeroOutWithRetry(
  client: PoolClient,
  args: { tenantId: string; userId: string; confirmPhrase: string },
): Promise<ZeroOutResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query("BEGIN");
      const result = await zeroOutRfidData(client, args);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore — connection may already be aborted */
      }
      const code = (e as { code?: string })?.code;
      if (code && RETRYABLE_SQLSTATES.has(code) && attempt < MAX_ATTEMPTS) {
        // Exponential backoff with jitter (0.1s, 0.2s, 0.4s, 0.8s) so
        // concurrent agent INSERTs get a window to commit before we retry.
        const backoff = 100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
        console.warn(
          `[rfid/zero-out] ${code} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${backoff}ms`,
        );
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }
}

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminRole(session.role)) {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });
  }

  let body: { confirm?: string };
  try {
    body = (await req.json()) as { confirm?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const client = await pool.connect();
  try {
    const result = await runZeroOutWithRetry(client, {
      tenantId: session.tid,
      userId: session.sub,
      confirmPhrase: body.confirm ?? "",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Zero-out failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[rfid/zero-out]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
