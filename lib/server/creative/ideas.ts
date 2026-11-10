/**
 * CarbonWMS Creative — "Give me ideas" (spec §8). ON DEMAND ONLY: one tap → ONE cheap LLM call →
 * 3–5 text-only cards. No images, no video, no background job. Inputs: new arrivals, best sellers,
 * slow movers (Shopify), upcoming dates, Radar winning patterns, CARBON's own best recipes.
 * "Make this" opens Create pre-filled; nothing renders until the normal draft / approve steps.
 */
import type { Pool } from "pg";
import { z } from "zod";
import { inStockCatalog } from "@/lib/server/email/catalog";
import { welcomeGql, welcomeShopCtx } from "@/lib/server/welcome/config";
import { brandBlock, getBrand } from "./config";
import { json } from "./llm";
import { ownWinners } from "./learning";
import { listRecipes } from "./recipes";
import { currentSeason } from "./radar/query";

const Ideas = z.object({
  ideas: z
    .array(
      z.object({
        idea: z.string().max(140),
        reason: z.string().max(160),
        product_refs: z.array(z.string()).max(3),
        kind: z.enum(["static", "video", "ugc", "animated", "campaign"]),
        recipe_key: z.string().nullable(),
        preset: z.enum(["street", "luxury", "evening", "florida"]),
      }),
    )
    .min(3)
    .max(5),
});

/** Upcoming dates that matter to CARBON in the next 6 weeks. */
export function upcomingDates(now = new Date()): string[] {
  const y = now.getFullYear();
  const thanksgiving = (() => {
    const d = new Date(y, 10, 1);
    const first = (4 - d.getDay() + 7) % 7;
    return new Date(y, 10, 1 + first + 21);
  })();
  const bf = new Date(thanksgiving.getTime() + 86_400_000);
  const cm = new Date(thanksgiving.getTime() + 4 * 86_400_000);
  const list: [Date, string][] = [
    [bf, "Black Friday"],
    [cm, "Cyber Monday"],
    [new Date(y, 11, 25), "Christmas"],
    [new Date(y, 11, 31), "New Year's Eve (going-out looks)"],
    [new Date(y + (now.getMonth() >= 2 ? 1 : 0), 1, 14), "Valentine's Day"],
    [new Date(y, 2, 10), "Spring break (Orlando)"],
    [new Date(y, 3, 20), "Prom season"],
    [new Date(y, 9, 31), "Halloween (Orlando nights out)"],
  ];
  const end = now.getTime() + 42 * 86_400_000;
  return list.filter(([d]) => d.getTime() >= now.getTime() - 86_400_000 && d.getTime() <= end).map(([d, n]) => `${n} — ${d.toDateString()}`);
}

export async function giveIdeas(pool: Pool, tenantId: string): Promise<{ ideas: { id: string; idea: string; reason: string; prefill: Record<string, unknown> }[]; cost: number }> {
  const brand = await getBrand(pool, tenantId);
  const cat = await inStockCatalog().catch(() => []);
  // New = Shopify's newest first (the catalog is sorted that way); slow = lots in stock.
  const newest = cat.slice(0, 12);
  const slow = [...cat].sort((a, b) => b.stock - a.stock).slice(0, 10);
  const sold = { rows: await bestSellers().catch(() => []) };
  const patterns = await pool.query<{ pattern: string; n: number; lane: string }>(
    `SELECT p.pattern, COUNT(*)::int AS n, MODE() WITHIN GROUP (ORDER BY a.tags->>'style_lane') AS lane
       FROM creative_ads a, jsonb_array_elements_text(a.tags->'creative_pattern') p(pattern)
      WHERE a.tenant_id = $1::uuid AND a.status = 'kept' AND a.winner_score >= 50 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    [tenantId],
  );
  const recipes = await listRecipes(pool, tenantId, { status: "active" });
  const own = await ownWinners(pool, tenantId);
  const ref = new Map<string, string>();
  const line = (p: (typeof cat)[number], tag: string) => {
    const r = `P${ref.size + 1}`;
    ref.set(r, p.id);
    return `${r} [${tag}] ${p.title} — $${p.price}${p.compareAt ? ` (was $${p.compareAt})` : ""}, ${p.stock} in stock, ${p.type}`;
  };
  const prompt = [
    "You are CARBON's creative director. Give 3–5 ad IDEAS (text only). Each = one-line idea + one-line reason that names the real signal it comes from.",
    brandBlock(brand),
    `Season: ${currentSeason().label}. Upcoming dates: ${upcomingDates().join("; ") || "none in the next 6 weeks"}.`,
    `NEW ARRIVALS:\n${newest.map((p) => line(p, "new")).join("\n") || "—"}`,
    `SLOW MOVERS (most stock):\n${slow.map((p) => line(p, "slow")).join("\n") || "—"}`,
    sold.rows.length ? `BEST SELLERS (last 30 days, units): ${sold.rows.map((s) => `${s.title} (${s.n})`).join(", ")}` : "",
    `WINNING IN RADAR (public activity signals): ${patterns.rows.map((p) => `${p.pattern} (${p.n} ads, ${p.lane})`).join("; ") || "Radar is still empty"}`,
    own.length ? `WORKS FOR CARBON: ${own.join("; ")}` : "",
    `RECIPES: ${recipes.map((r) => `${r.key} (${r.name})`).join(", ")}`,
    "product_refs = P-numbers from the lists. Never invent numbers or products. Example reason: 'Cargo pants are slow (40 in stock); speed-ramp walk-ins are winning in streetwear.'",
  ]
    .filter(Boolean)
    .join("\n\n");
  // Exactly one LLM call per tap.
  const r = await json(pool, prompt, Ideas, { tenantId, what: "give me ideas (1 call)", estimate: 0.05, maxOutputTokens: 1500 });
  const out = [];
  for (const i of r.value.ideas) {
    const prefill = { products: i.product_refs.map((x) => ref.get(x)).filter(Boolean), kind: i.kind, recipe: i.recipe_key, preset: i.preset };
    const row = await pool.query<{ id: string }>(`INSERT INTO creative_ideas (tenant_id, idea, reason, prefill, cost_usd) VALUES ($1::uuid, $2, $3, $4::jsonb, $5) RETURNING id`, [
      tenantId, i.idea, i.reason, JSON.stringify(prefill), r.cost / r.value.ideas.length,
    ]);
    out.push({ id: row.rows[0].id, idea: i.idea, reason: i.reason, prefill });
  }
  return { ideas: out, cost: r.cost };
}

/** Best sellers: units per product in Shopify orders of the last 30 days. */
export async function bestSellers(limit = 8): Promise<{ title: string; n: number }[]> {
  const ctx = await welcomeShopCtx();
  if (!ctx) return [];
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const d = await welcomeGql<{ orders: { nodes: { lineItems: { nodes: { title: string; quantity: number }[] } }[] } }>(
    ctx,
    `query B($q: String!) { orders(first: 250, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { lineItems(first: 30) { nodes { title quantity } } } } }`,
    { q: `created_at:>=${since} financial_status:paid` },
  );
  const m = new Map<string, number>();
  for (const o of d.orders.nodes) for (const li of o.lineItems.nodes) m.set(li.title, (m.get(li.title) ?? 0) + li.quantity);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([title, n]) => ({ title, n }));
}
