import { withActivity } from "@/lib/server/activity-log";
/**
 * GET   /api/marketing/ads — Meta and Google campaigns: status, daily budget,
 *       last 7 days (spend, impressions, clicks, purchases / conversions and value).
 * PATCH /api/marketing/ads { platform, id, action: "pause" | "resume" | "budget", dailyBudget?, budgetId?, confirm: true }
 *       — the screen asks first; `confirm` must be true. Never creates or launches a campaign.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { googleCampaigns, metaCampaigns, setCampaignBudget, setCampaignStatus } from "@/lib/server/marketing/ads";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const [meta, google] = await Promise.allSettled([metaCampaigns(), googleCampaigns()]);
  return NextResponse.json({
    meta: meta.status === "fulfilled" ? meta.value : [],
    google: google.status === "fulfilled" ? google.value : [],
    errors: {
      meta: meta.status === "rejected" ? String(meta.reason instanceof Error ? meta.reason.message : meta.reason) : null,
      google: google.status === "rejected" ? String(google.reason instanceof Error ? google.reason.message : google.reason) : null,
    },
  });
}

const schema = z
  .object({
    platform: z.enum(["meta", "google"]),
    id: z.string().regex(/^\d+$/),
    action: z.enum(["pause", "resume", "budget"]),
    dailyBudget: z.number().min(1).max(1000).optional(),
    budgetId: z.string().max(200).nullable().optional(),
    confirm: z.literal(true),
  })
  .strict();

async function PATCH_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Confirm the change first" }, { status: 400 });
  const b = parsed.data;
  try {
    if (b.action === "budget") {
      if (b.dailyBudget == null) return NextResponse.json({ error: "Give the new daily budget" }, { status: 400 });
      await setCampaignBudget(b.platform, b.id, b.budgetId ?? null, b.dailyBudget);
    } else await setCampaignStatus(b.platform, b.id, b.action === "resume");
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The change did not go through" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

export const PATCH = withActivity("marketing/ads", PATCH_handler);
