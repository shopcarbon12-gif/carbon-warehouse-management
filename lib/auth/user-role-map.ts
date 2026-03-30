/**
 * Maps `user_roles.name` (Senitron-style) to JWT `memberships.role`-compatible strings
 * used by `proxy.ts` / `dashboard-rbac.ts`.
 */
export function sessionRoleFromUserRoleName(name: string | null | undefined): string | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  if (n === "Super Admin") return "admin";
  if (n === "Retail- Limited acess") return "manager";
  if (n === "Warehouse - Limited Access") return "warehouse_ops";
  return null;
}
