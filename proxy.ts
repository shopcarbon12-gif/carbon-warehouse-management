import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import {
  isAdminOnlyPath,
  isAdminRole,
  isWarehouseFloorAllowedPath,
  isWarehouseFloorRole,
} from "@/lib/auth/dashboard-rbac";

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/docs")) return true;
  if (pathname === "/login") return true;
  if (pathname.startsWith("/api/health")) return true;
  if (pathname.startsWith("/api/auth/")) return true;
  /* Lightspeed R-Series OAuth: browser hits these without WMS session. */
  if (pathname.startsWith("/api/lightspeed/auth")) return true;
  if (pathname.startsWith("/api/lightspeed/callback")) return true;
  if (pathname.startsWith("/api/webhooks/")) return true;
  if (pathname.startsWith("/api/handheld")) return true;
  /* Handheld edge firehose (API key + device registry; no browser session). */
  if (pathname === "/api/edge/ingest") return true;
  if (pathname === "/api/settings/mobile-sync") return true;
  if (pathname === "/api/inventory/upload") return true;
  if (pathname === "/api/inventory/putaway-assign") return true;
  if (pathname === "/api/mobile/status") return true;
  if (pathname === "/api/mobile/epc-visibility") return true;
  return false;
}

export async function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    /\.(?:ico|png|jpg|jpeg|svg|webp|gif)$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  if (pathname === "/") {
    const token = req.cookies.get("wms_session")?.value;
    const session = token ? await verifySessionToken(token) : null;
    const url = req.nextUrl.clone();
    url.pathname = session ? "/dashboard" : "/login";
    return NextResponse.redirect(url);
  }

  const token = req.cookies.get("wms_session")?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const role = session.role ?? "member";

  if (!isAdminRole(role) && isAdminOnlyPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    url.searchParams.set("forbidden", "admin");
    return NextResponse.redirect(url);
  }

  if (isWarehouseFloorRole(role) && !isWarehouseFloorAllowedPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    url.searchParams.set("forbidden", "floor");
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
