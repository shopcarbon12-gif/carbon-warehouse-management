import { ReturnsWorkspace } from "@/components/shopify/returns-workspace";

export const dynamic = "force-dynamic";

export default function ShopifyReturnsPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <ReturnsWorkspace />
    </div>
  );
}
