import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { WAREHOUSE } from "@/lib/zones";

export async function GET() {
  const pool = getPool();
  let db = "disconnected";
  if (pool) {
    try {
      await pool.query("SELECT 1");
      db = "ok";
    } catch {
      db = "error";
    }
  }
  return NextResponse.json({
    ok: true,
    warehouse: WAREHOUSE,
    database: db,
  });
}
