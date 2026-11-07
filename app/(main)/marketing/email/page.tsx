import { Suspense } from "react";
import { EmailWorkspace } from "@/components/email/email-workspace";

export const dynamic = "force-dynamic";

export default function MarketingEmailPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <Suspense fallback={<p className="p-4 font-mono text-xs text-[var(--wms-muted)]">Loading email…</p>}>
        <EmailWorkspace />
      </Suspense>
    </div>
  );
}
