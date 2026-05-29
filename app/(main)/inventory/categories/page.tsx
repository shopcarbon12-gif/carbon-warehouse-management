import { getSession } from "@/lib/get-session";
import { CategoriesWorkspace } from "@/components/inventory/categories-workspace";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Categories</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Catalog categories and subcategories across all items, with style and variant counts.
        </p>
      </div>
      <CategoriesWorkspace />
    </div>
  );
}
