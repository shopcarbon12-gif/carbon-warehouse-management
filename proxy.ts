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
  /* Ops smoke: header secret only; disabled when WMS_OPS_SMOKE_SECRET unset (route returns 404). */
  if (pathname === "/api/internal/smoke/worker-queue") return true;
  if (pathname.startsWith("/api/auth/")) return true;
  /* Lightspeed R-Series OAuth: browser hits these without WMS session. */
  if (pathname.startsWith("/api/lightspeed/auth")) return true;
  if (pathname.startsWith("/api/lightspeed/callback")) return true;
  if (pathname.startsWith("/api/webhooks/")) return true;
  if (pathname.startsWith("/api/handheld")) return true;
  /* Handheld edge firehose (API key + device registry; no browser session). */
  if (pathname === "/api/edge/ingest") return true;
  /* Diagnostic SSE — Bearer-authed (WMS_DEVICE_KEY) so the ops team can
   * curl raw edge-scan events from the VPS without browser cookies. */
  if (pathname === "/api/diagnostic/edge-stream") return true;
  /* Carbon CDM agent endpoints: Bearer-authenticate inside each route via
   * cdm_agents.api_token_hash. No user session involved. */
  if (pathname === "/api/cdm-agents/heartbeat") return true;
  if (pathname === "/api/cdm-agents/config") return true;
  if (pathname === "/api/cdm-agents/reads") return true;
  if (pathname === "/api/cdm-agents/antenna-test-result") return true;
  if (pathname === "/api/cdm-agents/lookup-by-epc") return true;
  if (pathname === "/api/cdm-agents/set-monsoon-driver") return true;
  if (pathname === "/api/cdm-agents/active-sessions") return true;
  if (pathname === "/api/cdm-agents/reader-online") return true;
  if (pathname === "/api/cdm-agents/reader-offline") return true;
  /* Agent POSTs WIZnet LAN-discovery results here (Bearer-authed inside route).
   * Same path responds to admin GET (session-authed) — that branch goes through
   * isAdminOnlyPath instead of this allowlist. */
  if (pathname === "/api/cdm-agents/wiznet-discoveries") return true;
  /* Encode-jobs queue (Phase 2 of Encode Items). Agent polls GET /encode-jobs
   * to claim pending chip-write rows, POSTs /encode-jobs/[id]/result when
   * MonsoonReader --target_tag/--write_tag finishes. Both Bearer-authed
   * inside the routes; needed here or proxy short-circuits with 401 before
   * the handler ever runs (the workspace surfaces this as "chip-write
   * status unknown (no agent response in 60s)"). */
  if (pathname === "/api/cdm-agents/encode-jobs") return true;
  if (pathname.startsWith("/api/cdm-agents/encode-jobs/") && pathname.endsWith("/result")) return true;
  /* Public prewarm endpoint — fires on /login page mount. Reads source
   * public IP, matches agent, starts tenant's live-scan session early
   * so readers warm up while the operator types their password. No auth:
   * the IP match IS the auth. Heartbeat-based timeout cleans up if no
   * login completes. */
  if (pathname === "/api/agents/network-prewarm") return true;
  if (pathname === "/api/antenna-test/ingest") return true;
  if (pathname === "/api/settings/mobile-sync") return true;
  if (pathname === "/api/inventory/upload") return true;
  if (pathname === "/api/inventory/putaway-assign") return true;
  if (pathname === "/api/inventory/putaway-preview") return true;
  /* Count-session report archive (POST + GET list + GET /[id]/download + activities):
   * dual auth (session OR edge key) handled inside each route. */
  if (
    pathname === "/api/reports/count-sessions" ||
    pathname.startsWith("/api/reports/count-sessions/")
  ) return true;
  /* Per-device EPC drop queue: GET (mobile polling) is dual-auth (session OR edge key);
   * POST (web "Send to handheld") inside the route still requires session. */
  if (/^\/api\/devices\/[0-9a-f-]{36}\/epc-queue$/i.test(pathname)) return true;
  if (pathname === "/api/mobile/status") return true;
  if (pathname === "/api/mobile/epc-visibility") return true;
  /* OTA: handheld downloads APK with plain GET (no cookies). Else proxy redirects to /login HTML. */
  if (pathname.startsWith("/uploads/mobile-apk/")) return true;
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

  /**
   * All `/api/*` (except public allowlist above): authenticate with Bearer **or** cookie.
   * Return JSON 401 — never redirect to `/login` HTML (breaks mobile + `fetch` error handling).
   * RBAC lives inside each route handler (scopes), not here.
   */
  if (pathname.startsWith("/api/")) {
    const auth = req.headers.get("authorization");
    const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    let session = bearer ? await verifySessionToken(bearer) : null;
    if (!session) {
      const token = req.cookies.get("wms_session")?.value;
      session = token ? await verifySessionToken(token) : null;
    }
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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
