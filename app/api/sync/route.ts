import { NextResponse } from "next/server";
import { runProviderSync, type SyncProvider } from "@/lib/sync/runProviderSync";

const providers = new Set<SyncProvider>(["shopify", "lightspeed", "senitron"]);

export async function POST(req: Request) {
  let body: { provider?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const p = body.provider as SyncProvider;
  if (!p || !providers.has(p)) {
    return NextResponse.json(
      { error: "provider must be shopify | lightspeed | senitron" },
      { status: 400 }
    );
  }
  const result = await runProviderSync(p);
  return NextResponse.json(result);
}
