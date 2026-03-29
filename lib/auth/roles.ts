/**
 * RBAC scopes for Carbon WMS (web session + handheld API key paths).
 *
 * - `WAREHOUSE_OPS`: handheld / edge ingest only (API key; never a browser cookie).
 * - `MANAGER`: day-to-day web ops (catalog, transfers, dashboards).
 * - `ADMIN`: infrastructure (devices, forced vendor sync, tenant-wide settings).
 */

export const SCOPES = {
  WAREHOUSE_OPS: "warehouse_ops",
  MANAGER: "manager",
  ADMIN: "admin",
} as const;

export type AppScope = (typeof SCOPES)[keyof typeof SCOPES];

/** Membership.role values (see `memberships.role`); extend in seed / admin UI as needed. */
export type MembershipRoleName =
  | "admin"
  | "manager"
  | "member"
  | "warehouse_ops"
  | "handheld";

/**
 * Maps a DB membership role to effective scopes for **browser sessions**.
 * Handheld ingest does not use JWT scopes — it uses `WMS_DEVICE_KEY` / `WMS_EDGE_INGEST_KEY` only.
 */
export function scopesForMembershipRole(role: string): Set<AppScope> {
  const r = role.trim().toLowerCase() as MembershipRoleName;
  switch (r) {
    case "admin":
      return new Set([SCOPES.WAREHOUSE_OPS, SCOPES.MANAGER, SCOPES.ADMIN]);
    case "manager":
      return new Set([SCOPES.MANAGER]);
    case "warehouse_ops":
    case "handheld":
      return new Set([SCOPES.WAREHOUSE_OPS]);
    case "member":
    default:
      return new Set([SCOPES.MANAGER]);
  }
}

export function hasAllScopes(granted: Set<AppScope>, required: readonly AppScope[]): boolean {
  return required.every((s) => granted.has(s));
}
