"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Pie,
  PieChart,
  Cell,
} from "recharts";

type Summary = {
  unitsPerZone: { zone: string; units: number }[];
  ordersByStatus: { status: string; count: number }[];
};

const PIE_COLORS = ["#2dd4bf", "#0d9488", "#5eead4", "#134e4a", "#99f6e4", "#ccfbf1"];

export function ReportsCharts() {
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/reports/summary")
      .then((r) => r.json())
      .then((j: Summary) => setData(j))
      .catch(() => setErr("Could not load report data"));
  }, []);

  if (err) {
    return <p className="font-mono text-sm text-[var(--muted)]">{err}</p>;
  }
  if (!data) {
    return <p className="font-mono text-sm text-[var(--muted)]">Loading charts…</p>;
  }

  const pieData = data.ordersByStatus.map((o) => ({
    name: o.status.replace(/_/g, " "),
    value: o.count,
  }));

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4">
        <h3 className="mb-4 font-semibold text-[var(--foreground)]">Units by zone</h3>
        <div className="h-72 w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.unitsPerZone} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#243040" />
              <XAxis dataKey="zone" tick={{ fill: "#8b939e", fontSize: 11 }} />
              <YAxis tick={{ fill: "#8b939e", fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: "#141a21",
                  border: "1px solid #243040",
                  borderRadius: 8,
                }}
                labelStyle={{ color: "#e8eaed" }}
              />
              <Bar dataKey="units" fill="#2dd4bf" name="Units" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4">
        <h3 className="mb-4 font-semibold text-[var(--foreground)]">Orders by status</h3>
        {pieData.length === 0 ? (
          <p className="font-mono text-sm text-[var(--muted)]">No order data yet.</p>
        ) : (
          <div className="h-72 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={96}
                  label={({ name, percent }) =>
                    `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                  }
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: "#141a21",
                    border: "1px solid #243040",
                    borderRadius: 8,
                  }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
