import { ReportsCharts } from "@/components/ReportsCharts";
import { WAREHOUSE } from "@/lib/zones";

export default function ReportsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Reports & Analytics</h1>
      <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--muted)]">
        {WAREHOUSE.name} — Recharts views over PostgreSQL (units by zone, order pipeline).
      </p>

      <div className="mt-10">
        <ReportsCharts />
      </div>
    </div>
  );
}
