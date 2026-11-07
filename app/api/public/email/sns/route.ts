/**
 * POST /api/public/email/sns — Amazon SNS → CarbonWMS: SES delivery events
 * (delivered, opened, clicked, bounced, complained …) and the one-time
 * subscription confirmation. Public (proxy.ts); every message's signature is
 * checked against Amazon's certificate, and only our own topic is accepted.
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { applyEvent, type SesEvent } from "@/lib/server/email/campaigns";
import { subscribeUrlAllowed, verifySns, type SnsMessage } from "@/lib/server/email/sns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  let m: SnsMessage;
  try {
    m = JSON.parse(await req.text()) as SnsMessage;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!(await verifySns(m).catch(() => false))) return NextResponse.json({ error: "bad signature" }, { status: 403 });
  const ours = await pool.query(`SELECT 1 FROM email_settings WHERE sns_topic_arn = $1 LIMIT 1`, [m.TopicArn]);
  if (!ours.rowCount) return NextResponse.json({ error: "unknown topic" }, { status: 403 });
  if (m.Type === "SubscriptionConfirmation") {
    if (!subscribeUrlAllowed(m.SubscribeURL)) return NextResponse.json({ error: "bad subscribe url" }, { status: 400 });
    const r = await fetch(m.SubscribeURL!, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    console.log(`[email] SNS subscription confirmed: ${r?.status ?? "failed"}`);
    return NextResponse.json({ ok: Boolean(r?.ok) });
  }
  if (m.Type !== "Notification") return NextResponse.json({ ok: true });
  let ev: SesEvent;
  try {
    ev = JSON.parse(m.Message) as SesEvent;
  } catch {
    return NextResponse.json({ ok: true });
  }
  await applyEvent(pool, m.MessageId, ev);
  return NextResponse.json({ ok: true });
}
