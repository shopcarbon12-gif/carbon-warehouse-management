import Link from "next/link";
import { ExceptionsDashboard } from "@/components/operations/exceptions/exceptions-dashboard";

export const dynamic = "force-dynamic";

export default function OperationsExceptionsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">Exceptions</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          RFID dock alarms and exception audits. Resolve in place — metadata is merged onto the
          original <code className="text-[var(--wms-muted)]">audit_log</code> row. Legacy table:{" "}
          <Link href="/alerts" className="text-teal-400/90 hover:underline">
            Alerts
          </Link>
          .
        </p>
      </div>
      <ExceptionsDashboard />
    </div>
  );
}
