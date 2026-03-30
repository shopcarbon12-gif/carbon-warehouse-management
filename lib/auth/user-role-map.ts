/**
 * Maps `user_roles.name` (Carbon WMS / legacy-style) to JWT `memberships.role`-compatible strings
 * used by `proxy.ts` / `dashboard-rbac.ts`.
 */
export function sessionRoleFromUserRoleName(name: string | null | undefined): string | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  const key = n.toLowerCase().replace(/\s+/g, " ");
  if (key === "super admin" || key === "superadmin") return "admin";
  if (n === "Retail- Limited acess") return "manager";
  if (key === "warehouse - limited access") return "warehouse_ops";
  return null;
}
