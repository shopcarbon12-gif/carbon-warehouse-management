import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Collection Mapping is now the main Categories page; keep this old sub-route
// working by redirecting to it.
export default async function CollectionMappingPage() {
  redirect("/inventory/categories");
}
