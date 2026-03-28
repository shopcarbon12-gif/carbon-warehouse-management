import { NextResponse } from "next/server";
import { withDb } from "@/lib/db";
import { listInventory } from "@/lib/queries/inventory";

export async function GET() {
  const rows = await withDb((pool) => listInventory(pool), []);
  return NextResponse.json({ items: rows });
}
