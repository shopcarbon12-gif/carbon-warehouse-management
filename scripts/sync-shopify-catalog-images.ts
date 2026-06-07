/**
 * Pull Shopify product imagery into the catalog (matrices + custom_skus).
 *
 *   npx tsx scripts/sync-shopify-catalog-images.ts --upc=1125701
 *   npx tsx scripts/sync-shopify-catalog-images.ts --matrix=<uuid>
 *   npx tsx scripts/sync-shopify-catalog-images.ts --all
 *
 * Loads every key from .env.coolify.local (prod DB + Shopify admin creds) so
 * it can run against production from a dev workstation. Single source of
 * truth lives in lib/server/shopify-catalog-images.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import {
  syncShopifyImagesForMatrix,
  syncShopifyImagesForAll,
  matrixIdForUpc,
} from "@/lib/server/shopify-catalog-images";

/** Load ALL keys from an env file (first definition wins; never overrides existing process.env). */
function loadAllEnv(rel: string) {
  const p = join(process.cwd(), rel);
  if (!existsSync(p)) return;
  let text = readFileSync(p, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    if (process.env[key] !== undefined) continue;
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadAllEnv(".env.coolify.local");
loadAllEnv(".env.local");
loadAllEnv(".env");

const dbUrl = process.env.DATABASE_URL?.trim();
if (!dbUrl) {
  console.error("DATABASE_URL required (looked in .env.coolify.local / .env.local / .env)");
  process.exit(1);
}

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const wantAll = process.argv.includes("--all");
const upc = arg("upc");
const matrixArg = arg("matrix");

async function main() {
  const pool = new Pool({ connectionString: dbUrl, max: 1, ssl: false });
  try {
    console.log("Shopify domain:", process.env.SHOPIFY_SHOP_DOMAIN || "(unset)");
    if (wantAll) {
      let ok = 0;
      let fail = 0;
      const results = await syncShopifyImagesForAll(pool, (r) => {
        const tag = r.ok ? "OK " : "—  ";
        if (r.ok) ok += 1;
        else fail += 1;
        console.log(
          `${tag} ${r.upc ?? "(no upc)"} | ${r.description} | gallery=${r.galleryCount} variants=${r.variantsMatched}/${r.variantsTotal}` +
            (r.ok ? "" : ` | ${r.reason}`),
        );
      });
      console.log(`\nDONE — ${ok} synced, ${fail} skipped, ${results.length} matrices total`);
      return;
    }

    let matrixId = matrixArg;
    if (!matrixId && upc) {
      matrixId = await matrixIdForUpc(pool, upc);
      if (!matrixId) {
        console.error(`No matrix found for UPC ${upc}`);
        process.exit(1);
      }
    }
    if (!matrixId) {
      console.error("Pass --upc=<upc>, --matrix=<uuid>, or --all");
      process.exit(1);
    }

    const r = await syncShopifyImagesForMatrix(pool, matrixId);
    console.log("\nResult:", JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(2);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
