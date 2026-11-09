import { WelcomePopupWorkspace } from "@/components/shopify/welcome-popup-workspace";

export const dynamic = "force-dynamic";

/** Email Marketing → Sign-up forms: the storefront email popup (moved from Shopify, 2026-11-09). */
export default function SignupFormsPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <WelcomePopupWorkspace />
    </div>
  );
}
