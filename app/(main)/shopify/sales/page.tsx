import { SalesWorkspace } from "@/components/shopify/sales-workspace";

export const dynamic = "force-dynamic";

export default function ShopifySalesPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <SalesWorkspace />
    </div>
  );
}
