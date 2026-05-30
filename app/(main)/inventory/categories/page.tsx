import { getSession } from "@/lib/get-session";
import { CategoriesLegacyManager } from "@/components/inventory/categories-legacy-manager";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const session = await getSession();
  if (!session) return null;

  // Intentionally empty: the page is just a host for the top-right "Legacy"
  // button, which opens the full category manager popup.
  return <CategoriesLegacyManager />;
}
