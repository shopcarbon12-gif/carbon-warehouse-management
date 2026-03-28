import { cookies } from "next/headers";
import { verifySessionToken, type SessionPayload } from "@/lib/auth";

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get("wms_session")?.value;
  if (!token) return null;
  return verifySessionToken(token);
}
