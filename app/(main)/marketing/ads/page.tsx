import { MarketingAdsWorkspace } from "@/components/marketing/ads-workspace";

export const dynamic = "force-dynamic";

export default function MarketingAdsPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <MarketingAdsWorkspace />
    </div>
  );
}
