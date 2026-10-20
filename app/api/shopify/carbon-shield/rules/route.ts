import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/shopify/carbon-shield/rules — add an allow / block rule
 * (IP, IP range, network AS number, country, user-agent text or visitor
 * reference). Admin only. "Allow" beats every automatic check.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { shieldAdminGuard } from "@/lib/server/shield/guard";
import { invalidateShieldConfig } from "@/lib/server/shield/check";
import { cidrToRange, ipv4ToInt } from "@/lib/server/shield/ipdb";

export const dynamic = "force-dynamic";

const schema = z.object({
  kind: z.enum(["ip", "cidr", "asn", "country", "ua", "visitor"]),
  value: z.string().trim().min(1).max(200),
  action: z.enum(["allow", "block"]),
  note: z.string().trim().max(200).optional(),
});

function normalize(kind: string, value: string): string | null {
  switch (kind) {
    case "ip":
      return ipv4ToInt(value) !== null ? value.replace(/^::ffff:/i, "") : null;
    case "cidr":
      return cidrToRange(value) ? value : null;
    case "asn": {
      const n = value.replace(/^AS/i, "");
      return /^\d{1,10}$/.test(n) ? n : null;
    }
    case "country":
      return /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
    case "ua":
      return value.length >= 3 ? value : null;
    case "visitor":
      return /^[A-Za-z0-9-]{6,64}$/.test(value) ? value.toLowerCase() : null;
    default:
      return null;
  }
}

async function POST_handler(req: Request) {
  const g = await shieldAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid rule" }, { status: 400 });
  const value = normalize(parsed.data.kind, parsed.data.value);
  if (!value) return NextResponse.json({ error: `That is not a valid ${parsed.data.kind}` }, { status: 400 });
  const r = await g.pool.query<{ id: string }>(
    `INSERT INTO shield_rules (kind, value, action, note, created_by_email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, value) DO UPDATE SET action = EXCLUDED.action, note = EXCLUDED.note,
       created_at = now(), created_by_email = EXCLUDED.created_by_email
     RETURNING id::text`,
    [parsed.data.kind, value, parsed.data.action, parsed.data.note || null, g.session.email ?? null],
  );
  invalidateShieldConfig();
  return NextResponse.json({ ok: true, id: r.rows[0]?.id ?? null });
}

export const POST = withActivity("shopify/carbon-shield/rules", POST_handler);
