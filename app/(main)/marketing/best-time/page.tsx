import { MarketingBestTimeWorkspace } from "@/components/marketing/best-time-workspace";

export const dynamic = "force-dynamic";

export default function MarketingBestTimePage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <MarketingBestTimeWorkspace />
    </div>
  );
}
