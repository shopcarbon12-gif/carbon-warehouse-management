import { MarketingResultsWorkspace } from "@/components/marketing/results-workspace";

export const dynamic = "force-dynamic";

export default function MarketingResultsPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <MarketingResultsWorkspace />
    </div>
  );
}
