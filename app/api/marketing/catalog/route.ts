/**
 * GET /api/marketing/catalog?q=name — products in the Meta catalog (the ones
 * Instagram product tags can point at), in stock, one per name + colour.
 * For the tag picker on a Social post.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { searchCatalogProducts } from "@/lib/server/marketing/meta";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ products: [] });
  try {
    const seen = new Set<string>();
    const products = (await searchCatalogProducts(q))
      .filter((p) => p.availability === "in stock" && p.visibility !== "hidden")
      .filter((p) => {
        const k = `${p.name.toLowerCase()}|${(p.color ?? "").toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 30)
      .map((p) => ({ metaProductId: p.id, name: p.name, color: p.color, label: `${p.name}${p.color ? ` ${p.color.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}` : ""}` }));
    return NextResponse.json({ products });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Catalog search failed" }, { status: 502 });
  }
}
