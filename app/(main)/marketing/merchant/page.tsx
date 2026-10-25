import { MarketingMerchantWorkspace } from "@/components/marketing/merchant-workspace";

export const dynamic = "force-dynamic";

export default function MarketingMerchantPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <MarketingMerchantWorkspace />
    </div>
  );
}
