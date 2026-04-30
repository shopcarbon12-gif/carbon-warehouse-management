import { redirect } from "next/navigation";
import { getSession } from "@/lib/get-session";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { TransferOutWorkspace } from "@/components/operations/transfers/transfer-out-workspace";

export const dynamic = "force-dynamic";

export default async function TransferOutPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">Transfer Out</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Stage RFID + non-RFID inventory, send to a destination location. Items move to{" "}
          <span className="text-orange-400/80">IN TRANSIT</span> until received at the destination.
        </p>
      </div>
      <TransferOutWorkspace
        sessionLocationId={session.lid}
        isAdmin={isAdminRole(session.role)}
      />
    </div>
  );
}
