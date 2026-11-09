"use client";

/**
 * Email editor — the controls of the settings panel, the way Klaviyo's panel has them: groups with a
 * heading (optional groups show + to add and − to remove), colour fields (swatch + hex), padding as
 * Vertical / Horizontal with a split into four sides, a font row, alignment buttons, toggles.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Minus, Plus, Strikethrough, Underline, Unlink2, Link2 } from "lucide-react";
import { FONTS, FONT_CATS, fontStack, googleFontUrl, type Align, type Border, type Font, type Pad } from "@/lib/email-editor/types";

/** Load every library font into the editor page once (the picker shows each name in its own font). */
export function useEditorFonts() {
  useEffect(() => {
    for (const f of FONTS) {
      if (!f.google) continue;
      const id = `ce-font-${f.name.replace(/\s+/g, "-")}`;
      if (document.getElementById(id)) continue;
      const l = document.createElement("link");
      l.id = id;
      l.rel = "stylesheet";
      l.href = googleFontUrl(f);
      document.head.appendChild(l);
    }
  }, []);
}

/** Font menu: grouped like a fashion type kit, each name drawn in its own font, with search. */
export function FontPicker({ value, onChange, compact }: { value: string; onChange: (name: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  const list = FONTS.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div ref={box} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value}
        className={`${compact ? "h-8 w-36 border-[#E3E6EC] bg-white text-[#2b2f36]" : `${inputCls}`} flex items-center justify-between gap-1 truncate rounded border px-2 text-left text-[0.85rem]`}
        style={{ fontFamily: fontStack(value) }}
      >
        <span className="truncate">{value}</span>
        <span className="shrink-0 text-[0.6rem] opacity-60">▼</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-[80] flex max-h-[380px] w-[260px] flex-col overflow-hidden rounded-md border border-[#E3E6EC] bg-white text-[#1d2027] shadow-xl">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fonts" className="m-2 h-8 rounded border border-[#d5d9e0] px-2 text-[12px] outline-none focus:border-[#2F6FED]" />
          <div className="min-h-0 flex-1 overflow-y-auto pb-2" role="listbox">
            {FONT_CATS.map((cat) => {
              const items = list.filter((f) => f.cat === cat);
              if (!items.length) return null;
              return (
                <div key={cat}>
                  <div className="sticky top-0 bg-[#F6F7F9] px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#6b7280]">{cat === "Every inbox" ? "Same in every inbox" : cat}</div>
                  {items.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      role="option"
                      aria-selected={f.name === value}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onChange(f.name);
                        setOpen(false);
                      }}
                      className={`block w-full truncate px-3 py-1.5 text-left text-[17px] leading-tight hover:bg-[#EEF3FE] ${f.name === value ? "bg-[#EAF1FE] text-[#2F6FED]" : ""}`}
                      style={{ fontFamily: fontStack(f.name) }}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="border-t border-[#eef0f4] px-3 py-1.5 text-[10px] leading-snug text-[#6b7280]">Apple Mail and iPhone show these fonts; Gmail shows a close match.</p>
        </div>
      )}
    </div>
  );
}

export const inputCls =
  "h-8 w-full min-w-0 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 text-[0.8rem] text-[var(--wms-fg)] outline-none focus:border-[var(--wms-accent)]";

export function Group({ title, children, optional }: { title: string; children?: ReactNode; optional?: { on: boolean; toggle: () => void } }) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-[var(--wms-border)] px-4 py-3.5">
      <div className="flex items-center justify-between">
        <h4 className="text-[0.78rem] font-semibold text-[var(--wms-fg)]">{title}</h4>
        {optional && (
          <button
            type="button"
            onClick={optional.toggle}
            className="grid h-6 w-6 place-items-center rounded text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
            aria-label={optional.on ? `Remove ${title}` : `Add ${title}`}
            title={optional.on ? "Remove" : "Add"}
          >
            {optional.on ? <Minus size={14} /> : <Plus size={14} />}
          </button>
        )}
      </div>
      {(!optional || optional.on) && children}
    </section>
  );
}

export function Field({ label, children, inline }: { label: string; children: ReactNode; inline?: boolean }) {
  const id = useId();
  return (
    <div className={inline ? "flex items-center justify-between gap-3" : "flex min-w-0 flex-col gap-1"}>
      <label htmlFor={id} className="text-[0.72rem] text-[var(--wms-muted)]">
        {label}
      </label>
      <div id={id} className={inline ? "shrink-0" : "min-w-0"}>
        {children}
      </div>
    </div>
  );
}

export function Text({ value, onChange, placeholder, area }: { value: string; onChange: (v: string) => void; placeholder?: string; area?: boolean }) {
  return area ? (
    <textarea className={`${inputCls} h-24 py-1.5 font-mono text-[0.75rem]`} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  ) : (
    <input className={inputCls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  );
}

export function Num({ value, onChange, unit = "px", min = 0, max = 2000, step = 1, width = "w-[86px]" }: { value: number; onChange: (v: number) => void; unit?: string; min?: number; max?: number; step?: number; width?: string }) {
  return (
    <div className={`relative ${width}`}>
      <input
        type="number"
        className={`${inputCls} pr-7 tabular-nums`}
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
      />
      {unit && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[0.68rem] text-[var(--wms-muted)]">{unit}</span>}
    </div>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export function Color({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [txt, setTxt] = useState(value.replace("#", "").toUpperCase());
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setTxt(value.replace("#", "").toUpperCase());
  }
  const full = /^#[0-9a-fA-F]{3}$/.test(value) ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}` : value;
  return (
    <div className="flex h-8 w-[132px] items-center gap-1.5 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1.5">
      <input type="color" aria-label="Pick a colour" value={HEX.test(full) ? full : "#000000"} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-5 w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
      <span className="text-[0.75rem] text-[var(--wms-muted)]">#</span>
      <input
        className="w-full min-w-0 bg-transparent font-mono text-[0.78rem] text-[var(--wms-fg)] outline-none"
        value={txt}
        maxLength={6}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
          setTxt(t);
          if (t.length === 6) onChange(`#${t}`);
        }}
      />
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[0.75rem] text-[var(--wms-fg)]">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--wms-accent)]" : "bg-[var(--wms-border)]"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${checked ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

export function Select<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: ReactNode; title: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          title={o.title}
          aria-label={o.title}
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={`grid h-7 min-w-7 place-items-center rounded px-1.5 text-[0.72rem] ${value === o.v ? "bg-[var(--wms-surface)] text-[var(--wms-fg)] shadow-sm" : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function AlignSeg({ value, onChange }: { value: Align; onChange: (v: Align) => void }) {
  return (
    <Seg
      value={value}
      onChange={onChange}
      options={[
        { v: "left", label: <AlignLeft size={14} />, title: "Left" },
        { v: "center", label: <AlignCenter size={14} />, title: "Center" },
        { v: "right", label: <AlignRight size={14} />, title: "Right" },
      ]}
    />
  );
}

/** Padding: Vertical + Horizontal, or four sides (the split icon). */
export function PadField({ value, onChange, label = "Padding" }: { value: Pad; onChange: (p: Pad) => void; label?: string }) {
  const [split, setSplit] = useState(value.t !== value.b || value.l !== value.r);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[0.72rem] text-[var(--wms-muted)]">{label}</span>
        <button type="button" onClick={() => setSplit(!split)} title={split ? "Same on both sides" : "Individual padding"} className="grid h-6 w-6 place-items-center rounded text-[var(--wms-muted)] hover:text-[var(--wms-fg)]">
          {split ? <Link2 size={13} /> : <Unlink2 size={13} />}
        </button>
      </div>
      {split ? (
        <div className="grid grid-cols-4 gap-1.5">
          {(["t", "r", "b", "l"] as const).map((k) => (
            <div key={k} className="flex flex-col gap-0.5">
              <Num value={value[k]} onChange={(v) => onChange({ ...value, [k]: v })} width="w-full" unit="" />
              <span className="text-center text-[0.62rem] text-[var(--wms-muted)]">{{ t: "Top", r: "Right", b: "Bottom", l: "Left" }[k]}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-0.5">
            <Num value={value.t} onChange={(v) => onChange({ ...value, t: v, b: v })} width="w-full" />
            <span className="text-[0.62rem] text-[var(--wms-muted)]">Vertical</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <Num value={value.l} onChange={(v) => onChange({ ...value, l: v, r: v })} width="w-full" />
            <span className="text-[0.62rem] text-[var(--wms-muted)]">Horizontal</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function FontRow({ value, onChange }: { value: Font; onChange: (f: Font) => void }) {
  const flag = (k: "bold" | "italic" | "underline" | "strike", icon: ReactNode, title: string) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={!!value[k]}
      onClick={() => onChange({ ...value, [k]: !value[k] })}
      className={`grid h-7 w-7 place-items-center rounded ${value[k] ? "bg-[var(--wms-surface)] text-[var(--wms-fg)] shadow-sm" : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"}`}
    >
      {icon}
    </button>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <FontPicker value={value.family} onChange={(family) => onChange({ ...value, family })} />
        <Num value={value.size} onChange={(v) => onChange({ ...value, size: v })} min={6} max={160} width="w-[88px]" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Color value={value.color} onChange={(c) => onChange({ ...value, color: c })} />
        <div className="flex items-center gap-1" title="Letter spacing">
          <span className="text-[0.68rem] text-[var(--wms-muted)]">Spacing</span>
          <Num value={value.ls} onChange={(v) => onChange({ ...value, ls: v })} min={-5} max={20} step={0.5} width="w-[70px]" />
        </div>
      </div>
      <div className="inline-flex w-fit rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-0.5">
        {flag("bold", <Bold size={13} />, "Bold")}
        {flag("italic", <Italic size={13} />, "Italic")}
        {flag("underline", <Underline size={13} />, "Underline")}
        {flag("strike", <Strikethrough size={13} />, "Strikethrough")}
      </div>
    </div>
  );
}

export function BorderGroup({ value, onChange, title = "Border" }: { value: Border | null; onChange: (b: Border | null) => void; title?: string }) {
  return (
    <Group title={title} optional={{ on: !!value, toggle: () => onChange(value ? null : { style: "solid", width: 1, color: "#000000" }) }}>
      {value && (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Select
            value={value.style}
            onChange={(v) => onChange({ ...value, style: v })}
            options={[
              { v: "solid", label: "Solid" },
              { v: "dashed", label: "Dashed" },
              { v: "dotted", label: "Dotted" },
            ]}
          />
          <Num value={value.width} onChange={(v) => onChange({ ...value, width: v })} max={20} width="w-[74px]" />
          <div className="col-span-2">
            <Color value={value.color} onChange={(c) => onChange({ ...value, color: c })} />
          </div>
        </div>
      )}
    </Group>
  );
}

/** A colour that can be switched off (block background, section colour …). */
export function OptColor({ title, value, onChange, fallback = "#F5F5F5" }: { title: string; value: string | null; onChange: (v: string | null) => void; fallback?: string }) {
  return (
    <Group title={title} optional={{ on: value != null, toggle: () => onChange(value != null ? null : fallback) }}>
      {value != null && <Color value={value} onChange={onChange} />}
    </Group>
  );
}
