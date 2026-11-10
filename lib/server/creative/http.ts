/**
 * CarbonWMS Creative — shared bits for the API routes: the admin guard (single owner, like Social),
 * plain-English errors, and "kick": run due jobs straight after a tap (in the background, after
 * the response), one runner per tenant at a time.
 */
import { NextResponse, after } from "next/server";
import type { Pool } from "pg";
import { ZodError, type ZodType } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { PlainError } from "./config";
import { tick, plainMessage } from "./jobs";

export const guard = marketingAdminGuard;

const running = new Set<string>();

export async function runJobs(pool: Pool, tenantId: string, budgetMs = 240_000): Promise<void> {
  if (running.has(tenantId)) return;
  running.add(tenantId);
  try {
    // Loaded on first use, so each API route doesn't bundle the whole engine.
    const { HANDLERS } = await import("./handlers");
    await tick(pool, tenantId, HANDLERS, budgetMs);
  } catch (e) {
    console.error("[creative] tick failed", e);
  } finally {
    running.delete(tenantId);
  }
}

/** Run due jobs after this response is sent. */
export function kick(pool: Pool, tenantId: string): void {
  after(() => runJobs(pool, tenantId));
}

export function fail(e: unknown): NextResponse {
  if (e instanceof ZodError) return NextResponse.json({ error: e.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  if (e instanceof PlainError) return NextResponse.json({ error: e.message }, { status: 400 });
  console.error("[creative]", e);
  return NextResponse.json({ error: plainMessage(e) }, { status: 500 });
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  return schema.parse(await req.json().catch(() => ({})));
}
