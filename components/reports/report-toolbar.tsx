"use client";

import { CalendarRange, Search } from "lucide-react";

const dateInputClass =
  "rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--wms-accent)]/40 dark:border-[var(--wms-border)]";

type ReportToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  onExportCsv: () => void;
  exportDisabled?: boolean;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
};

export function ReportToolbar({
  search,
  onSearchChange,
  onExportCsv,
  exportDisabled,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
}: ReportToolbarProps) {
  const hasRange = Boolean(dateFrom || dateTo);
  const clearRange = () => {
    onDateFromChange("");
    onDateToChange("");
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between dark:border-[var(--wms-border)]">
      <label className="relative flex min-w-[12rem] flex-1 items-center gap-2 sm:max-w-md">
        <Search
          className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--wms-muted)]"
          strokeWidth={1.75}
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by SKU / EPC…"
          className="w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-2 pl-9 pr-3 font-mono text-xs text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--wms-accent)]/40 dark:border-[var(--wms-border)]"
          autoComplete="off"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 dark:border-[var(--wms-border)]"
          title="Filter rows by created_at (inclusive end date, server date)"
        >
          <CalendarRange className="h-3.5 w-3.5 shrink-0 text-[var(--wms-muted)]" aria-hidden />
          <label className="flex items-center gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">From</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => onDateFromChange(e.target.value)}
              className={dateInputClass}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">To</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => onDateToChange(e.target.value)}
              className={dateInputClass}
            />
          </label>
          {hasRange ? (
            <button
              type="button"
              onClick={clearRange}
              className="rounded-md px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-accent)] hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onExportCsv}
          disabled={exportDisabled}
          className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs font-medium text-[var(--wms-fg)] transition-colors hover:bg-[var(--wms-accent)]/15 hover:text-[var(--wms-accent)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[var(--wms-border)]"
        >
          Export CSV
        </button>
      </div>
    </div>
  );
}
