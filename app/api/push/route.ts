import { withActivity } from "@/lib/server/activity-log";
/**
 * Phone/computer alerts for Shopify orders and Studio night-batch results.
 *
 *   GET    /api/push                  → { publicKey, devices }   (this user's signed-up devices)
 *   POST   /api/push { subscription, kinds? } → sign this browser up (upsert by endpoint)
 *   DELETE /api/push { endpoint }     → turn alerts off on this browser
 *
 * Admin only: the alerts carry order totals. See lib/server/web-push.ts.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getVapidKeys } from "@/lib/server/web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(["orders", "studio"]);

async function authed(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  return { session, pool };
}

export async function GET(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const { publicKey } = await getVapidKeys(a.pool);
  const devices = UUID_RE.test(String(a.session.sub || ""))
    ? (
        await a.pool.query<{ endpoint: string; kinds: string[]; user_agent: string | null; last_ok_at: string | null }>(
          `SELECT endpoint, kinds, user_agent, last_ok_at FROM web_push_subscriptions WHERE user_id = $1::uuid ORDER BY created_at`,
          [a.session.sub],
        )
      ).rows
    : [];
  return NextResponse.json({ publicKey, devices });
}

async function POST_handler(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const body = await req.json().catch(() => ({}));
  const sub = body?.subscription;
  const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint.trim() : "";
  const p256dh = typeof sub?.keys?.p256dh === "string" ? sub.keys.p256dh : "";
  const auth = typeof sub?.keys?.auth === "string" ? sub.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !p256dh || !auth) {
    return NextResponse.json({ error: "A browser push subscription is required." }, { status: 400 });
  }
  const kinds = Array.isArray(body?.kinds) ? body.kinds.filter((k: unknown) => KINDS.has(String(k))) : ["orders", "studio"];
  await a.pool.query(
    `INSERT INTO web_push_subscriptions (tenant_id, user_id, email, endpoint, p256dh, auth, user_agent, kinds)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::text[])
     ON CONFLICT (endpoint) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id, user_id = EXCLUDED.user_id, email = EXCLUDED.email,
       p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent,
       kinds = EXCLUDED.kinds, updated_at = now(), last_error = NULL`,
    [
      UUID_RE.test(String(a.session.tid || "")) ? a.session.tid : null,
      UUID_RE.test(String(a.session.sub || "")) ? a.session.sub : null,
      a.session.email ?? null,
      endpoint,
      p256dh,
      auth,
      String(req.headers.get("user-agent") || "").slice(0, 300),
      kinds.length ? kinds : ["orders", "studio"],
    ],
  );
  return NextResponse.json({ ok: true });
}

async function DELETE_handler(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const body = await req.json().catch(() => ({}));
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  const r = await a.pool.query(`DELETE FROM web_push_subscriptions WHERE endpoint = $1`, [endpoint]);
  return NextResponse.json({ ok: true, removed: r.rowCount });
}

export const POST = withActivity("push", POST_handler);
export const DELETE = withActivity("push", DELETE_handler);
