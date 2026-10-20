import { CarbonShieldWorkspace } from "@/components/shopify/carbon-shield-workspace";

export const dynamic = "force-dynamic";

export default function CarbonShieldPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <CarbonShieldWorkspace />
    </div>
  );
}
