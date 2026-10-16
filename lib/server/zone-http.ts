import { NextResponse } from "next/server";

/** Turns BAD_REQUEST:… errors into 400s, everything else into a 500. */
export function zoneError(e: unknown, tag: string): NextResponse {
  const msg = e instanceof Error ? e.message : "Failed";
  if (msg.startsWith("BAD_REQUEST:")) {
    return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
  }
  console.error(`[${tag}]`, e);
  return NextResponse.json({ error: "Failed" }, { status: 500 });
}
