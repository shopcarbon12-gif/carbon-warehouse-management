/**
 * Path rules for `proxy.ts` (runs before RSC; no DB round-trip).
 * Roles come from the signed session JWT (`memberships.role` at login).
 */

export function isAdminRole(role: string): boolean {
  return role.trim().toLowerCase() === "admin";
}

export function isWarehouseFloorRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  return r === "warehouse_ops" || r === "handheld";
}

/** Pages + APIs reserved for tenant admins (Devices, vendor sync UI, infra settings). */
export function isAdminOnlyPath(pathname: string): boolean {
  if (pathname.startsWith("/infrastructure")) return true;
  if (pathname.startsWith("/inventory/sync")) return true;
  if (pathname.startsWith("/api/infrastructure")) return true;
  if (pathname.startsWith("/api/inventory/sync")) return true;
  if (pathname.startsWith("/infrastructure/lightspeed-sales")) return true;
  if (pathname.startsWith("/api/lightspeed/sales")) return true;
  return false;
}

/**
 * Warehouse floor operators (handheld-style web): operations floor + catalog only (+ shared APIs).
 */
export function isWarehouseFloorAllowedPath(pathname: string): boolean {
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return true;
  if (pathname.startsWith("/operations")) return true;
  if (pathname.startsWith("/inventory/catalog")) return true;
  if (pathname.startsWith("/handheld")) return true;

  if (pathname.startsWith("/api/dashboard")) return true;
  if (pathname.startsWith("/api/locations")) return true;
  if (pathname.startsWith("/api/operations")) return true;
  if (pathname.startsWith("/api/inventory/catalog")) return true;
  if (pathname.startsWith("/api/rfid/cycle-counts")) return true;
  if (pathname.startsWith("/api/edge/stream")) return true;
  if (pathname.startsWith("/api/session")) return true;
  if (pathname.startsWith("/api/auth")) return true;

  return false;
}
