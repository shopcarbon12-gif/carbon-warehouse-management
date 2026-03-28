import { NextResponse } from "next/server";
import { withDb } from "@/lib/db";
import { listOrders } from "@/lib/queries/orders";

export async function GET() {
  const rows = await withDb((pool) => listOrders(pool), []);
  return NextResponse.json({ orders: rows });
}
