import { MarketingCalendarWorkspace } from "@/components/marketing/calendar-workspace";

export const dynamic = "force-dynamic";

export default function MarketingCalendarPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <MarketingCalendarWorkspace />
    </div>
  );
}
