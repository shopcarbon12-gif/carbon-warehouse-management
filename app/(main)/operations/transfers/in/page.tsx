import { redirect } from "next/navigation";
import { getSession } from "@/lib/get-session";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { TransferInWorkspace } from "@/components/operations/transfers/transfer-in-workspace";

export const dynamic = "force-dynamic";

export default async function TransferInPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">Transfer In</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Receive in-transit transfers headed to your location. RFID items return to{" "}
          <span className="text-emerald-400/80">in-stock</span> with auto-binning; manual lines
          settle into catalog qty.
        </p>
      </div>
      <TransferInWorkspace
        sessionLocationId={session.lid}
        isAdmin={isAdminRole(session.role)}
      />
    </div>
  );
}
