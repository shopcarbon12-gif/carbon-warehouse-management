import { WelcomePopupWorkspace } from "@/components/shopify/welcome-popup-workspace";

export const dynamic = "force-dynamic";

export default function WelcomePopupPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <WelcomePopupWorkspace />
    </div>
  );
}
