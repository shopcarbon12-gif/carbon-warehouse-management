"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useState } from "react";
import { InventoryAuditLogWorkspace } from "@/components/reports/inventory-audit-log-workspace";

type StatusTab = "STATUS_CHANGE" | "KILLED_TAG" | "RESOLVED_KILLED_TAG";

const TAB_TRIGGER =
  "rounded-md px-3 py-2 font-mono text-[0.65rem] font-medium uppercase tracking-wider text-[var(--wms-muted)] transition-colors data-[state=active]:bg-[var(--wms-surface-elevated)] data-[state=active]:text-[var(--wms-accent)] data-[state=active]:ring-1 data-[state=active]:ring-[var(--wms-border)] hover:text-[var(--wms-fg)] dark:data-[state=active]:ring-[var(--wms-border)]";

const EMPTY: Record<StatusTab, string> = {
  STATUS_CHANGE: "No status change entries yet.",
  KILLED_TAG: "No killed tag entries yet.",
  RESOLVED_KILLED_TAG: "No resolved killed tag entries yet.",
};

const EXPORT_PREFIX: Record<StatusTab, string> = {
  STATUS_CHANGE: "status-change-logs",
  KILLED_TAG: "killed-tag-logs",
  RESOLVED_KILLED_TAG: "resolved-killed-tag-logs",
};

export function StatusLogsWorkspace() {
  const [tab, setTab] = useState<StatusTab>("STATUS_CHANGE");

  return (
    <div className="flex flex-col gap-4">
      <Tabs.Root value={tab} onValueChange={(v) => setTab(v as StatusTab)}>
        <Tabs.List
          className="flex flex-wrap gap-1 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-1 dark:border-[var(--wms-border)]"
          aria-label="Status and tag log categories"
        >
          <Tabs.Trigger value="STATUS_CHANGE" className={TAB_TRIGGER}>
            Change status
          </Tabs.Trigger>
          <Tabs.Trigger value="KILLED_TAG" className={TAB_TRIGGER}>
            Killed tags
          </Tabs.Trigger>
          <Tabs.Trigger value="RESOLVED_KILLED_TAG" className={TAB_TRIGGER}>
            Resolved killed tags
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>
      <InventoryAuditLogWorkspace
        key={tab}
        logTypes={[tab]}
        exportFilePrefix={EXPORT_PREFIX[tab]}
        emptyLabel={EMPTY[tab]}
      />
    </div>
  );
}
