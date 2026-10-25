import { withActivity } from "@/lib/server/activity-log";
/**
 * POST   /api/marketing/channels/bluesky { handle, appPassword } — connect
 *        Bluesky: signs in once to check, then keeps the app password sealed
 *        (lib/server/secret-box.ts). It is never shown back.
 * DELETE — disconnect.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { blueskyLogin } from "@/lib/server/marketing/bluesky";
import { seal } from "@/lib/server/secret-box";

export const dynamic = "force-dynamic";

const schema = z.object({ handle: z.string().min(3).max(200), appPassword: z.string().min(8).max(100) }).strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Give the Bluesky handle and an app password" }, { status: 400 });
  try {
    const s = await blueskyLogin(parsed.data.handle, parsed.data.appPassword);
    await g.pool.query(`DELETE FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'bluesky'`, [g.session.tid]);
    await g.pool.query(
      `INSERT INTO marketing_channels (tenant_id, provider, account_id, name, status, secret, last_ok_at) VALUES ($1::uuid, 'bluesky', $2, $3, 'connected', $4, now())`,
      [g.session.tid, s.did, s.handle, seal(parsed.data.appPassword.trim())],
    );
    return NextResponse.json({ handle: s.handle });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bluesky sign-in failed" }, { status: 400 });
  }
}

async function DELETE_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  await g.pool.query(`DELETE FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'bluesky'`, [g.session.tid]);
  return NextResponse.json({ ok: true });
}

export const POST = withActivity("marketing/channels/bluesky", POST_handler);
export const DELETE = withActivity("marketing/channels/bluesky", DELETE_handler);
