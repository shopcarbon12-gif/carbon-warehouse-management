"use client";

import { Maximize2, Moon, Sun, Type } from "lucide-react";
import { useWmsTheme, type ThemeCombo } from "@/components/theme/theme-provider";

const combos: { id: string; label: string; combo: ThemeCombo; icon: typeof Moon }[] = [
  { id: "dark-comf", label: "Dark · Default type", combo: { color: "dark", font: "comfortable" }, icon: Moon },
  { id: "dark-exp", label: "Dark · Extra large", combo: { color: "dark", font: "expanded" }, icon: Type },
  { id: "light-comf", label: "Light · Default type", combo: { color: "light", font: "comfortable" }, icon: Sun },
  { id: "light-exp", label: "Light · Extra large", combo: { color: "light", font: "expanded" }, icon: Maximize2 },
];

export function ThemeSettingsWorkspace() {
  const { colorMode, fontScale, setTheme } = useWmsTheme();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <p className="font-mono text-[0.75em] text-[var(--wms-muted)]">
        Saved in this browser only. Default type is the former “large” scale (~18px root). Extra large bumps
        the root again and relaxes control heights when labels need more room.{" "}
        <code className="text-[var(--wms-accent)]">&lt;html&gt;</code>
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
              <span className="font-mono text-[0.65em] text-[var(--wms-muted)]">
                {c.combo.color === "dark" ? "Dark UI" : "Light UI"} ·{" "}
                {c.combo.font === "expanded" ? "Larger type + roomier fields" : "Balanced readability"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
