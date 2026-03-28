import { getPool } from "@/lib/db";
import { insertSyncRun } from "@/lib/queries/sync";
import { shopifyConfigured, shopifyHealthPing } from "@/lib/integrations/shopify";
import { lightspeedConfigured, lightspeedHealthPing } from "@/lib/integrations/lightspeed";
import { senitronConfigured, senitronHealthPing } from "@/lib/integrations/senitron";

export type SyncProvider = "shopify" | "lightspeed" | "senitron";

export async function runProviderSync(provider: SyncProvider): Promise<{
  ok: boolean;
  message: string;
}> {
  const pool = getPool();
  if (!pool) {
    return { ok: false, message: "DATABASE_URL not set — cannot log sync run" };
  }

  try {
    if (provider === "shopify") {
      if (!shopifyConfigured()) {
        const msg = "Shopify not configured";
        await insertSyncRun(pool, provider, "skipped", msg, true);
        return { ok: false, message: msg };
      }
      const ping = await shopifyHealthPing();
      const msg = ping.ok ? "Shop reachable" : (ping.detail ?? "error");
      await insertSyncRun(pool, provider, ping.ok ? "ok" : "error", msg, true);
      return { ok: ping.ok, message: msg };
    }

    if (provider === "lightspeed") {
      if (!lightspeedConfigured()) {
        const msg = "Lightspeed not configured";
        await insertSyncRun(pool, provider, "skipped", msg, true);
        return { ok: false, message: msg };
      }
      const ping = await lightspeedHealthPing();
      const msg = ping.detail ?? (ping.ok ? "ok" : "error");
      await insertSyncRun(pool, provider, ping.ok ? "ok" : "skipped", msg, true);
      return { ok: ping.ok, message: msg };
    }

    if (!senitronConfigured()) {
      const msg = "Senitron not configured";
      await insertSyncRun(pool, provider, "skipped", msg, true);
      return { ok: false, message: msg };
    }
    const ping = await senitronHealthPing();
    const msg = ping.detail ?? (ping.ok ? "Reachable" : "error");
    await insertSyncRun(pool, provider, ping.ok ? "ok" : "error", msg, true);
    return { ok: ping.ok, message: msg };
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    await insertSyncRun(pool, provider, "error", message, true);
    return { ok: false, message };
  }
}
