"use client";

import { Monitor, Moon, Sun, Type } from "lucide-react";
import { useWmsTheme, type ThemeCombo } from "@/components/theme/theme-provider";

const combos: { id: string; label: string; combo: ThemeCombo; icon: typeof Moon }[] = [
  { id: "dark-std", label: "Dark · Standard", combo: { color: "dark", font: "standard" }, icon: Moon },
  { id: "dark-lg", label: "Dark · Large type", combo: { color: "dark", font: "large" }, icon: Type },
  { id: "light-std", label: "Light · Standard", combo: { color: "light", font: "standard" }, icon: Sun },
  { id: "light-lg", label: "Light · Large type", combo: { color: "light", font: "large" }, icon: Monitor },
];

export function ThemeSettingsWorkspace() {
  const { colorMode, fontScale, setTheme } = useWmsTheme();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <p className="font-mono text-xs text-[var(--wms-muted)]">
        Preference is saved in this browser only. Large type scales the interface from the{" "}
        <code className="text-[var(--wms-accent)]">&lt;html&gt;</code> root.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {combos.map((c) => {
          const active = colorMode === c.combo.color && fontScale === c.combo.font;
          const Icon = c.icon;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setTheme(c.combo)}
              className={`flex flex-col items-start gap-3 rounded-xl border p-5 text-left transition-colors ${
                active
                  ? "border-[var(--wms-accent)] bg-[var(--wms-surface-elevated)] ring-2 ring-[var(--wms-accent)]/30"
                  : "border-[var(--wms-border)] bg-[var(--wms-surface)] hover:border-[var(--wms-muted)]"
              }`}
            >
              <Icon className="h-8 w-8 text-[var(--wms-accent)]" strokeWidth={1.5} />
              <span className="text-base font-semibold text-[var(--wms-fg)]">{c.label}</span>
              <span className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
                {c.combo.color === "dark" ? "Dark UI" : "Light UI"} ·{" "}
                {c.combo.font === "large" ? "Scaled typography" : "Default size"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
