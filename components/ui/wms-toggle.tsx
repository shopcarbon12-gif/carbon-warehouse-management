"use client";

type WmsToggleProps = {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
};

/**
 * Accessible switch with depth + glow (uses theme CSS variables for light/dark).
 */
export function WmsToggle({ checked, onChange, label }: WmsToggleProps) {
  return (
    <label className="flex min-h-[2.75em] cursor-pointer items-center justify-between gap-4 border-b border-[var(--wms-border)] py-3 font-mono text-[0.8125em] text-[var(--wms-fg)] last:border-0">
      <span className="min-w-0 flex-1 pr-2 leading-snug">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={[
          "relative h-8 w-[3.25rem] shrink-0 rounded-full transition-all duration-300 ease-out",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wms-accent)]",
          checked
            ? [
                "border border-white/25 shadow-[0_0_22px_color-mix(in_oklab,var(--wms-accent)_55%,transparent),0_6px_14px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.35)]",
                "bg-[linear-gradient(180deg,color-mix(in_oklab,var(--wms-accent)_92%,white)_0%,var(--wms-accent)_45%,color-mix(in_oklab,var(--wms-accent)_75%,black)_100%)]",
              ].join(" ")
            : [
                "border border-[var(--wms-border)] shadow-[inset_0_3px_8px_rgba(0,0,0,0.45),0_2px_4px_rgba(0,0,0,0.15)]",
                "bg-[linear-gradient(180deg,color-mix(in_oklab,var(--wms-surface-elevated)_100%,white)_0%,var(--wms-surface)_55%,color-mix(in_oklab,var(--wms-bg)_80%,black)_100%)]",
              ].join(" "),
        ].join(" ")}
      >
        <span
          className={[
            "pointer-events-none absolute top-1 h-6 w-6 rounded-full transition-transform duration-300 ease-out",
            "bg-[linear-gradient(165deg,#ffffff_0%,#e2e8f0_55%,#cbd5e1_100%)]",
            "shadow-[0_3px_8px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.95),inset_0_-2px_4px_rgba(0,0,0,0.12)]",
            checked ? "translate-x-[1.35rem]" : "translate-x-1",
          ].join(" ")}
        />
      </button>
    </label>
  );
}
