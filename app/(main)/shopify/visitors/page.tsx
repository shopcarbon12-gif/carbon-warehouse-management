import { VisitorsWorkspace } from "@/components/shopify/visitors-workspace";

export const dynamic = "force-dynamic";

export default function VisitorsPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <VisitorsWorkspace />
    </div>
  );
}
