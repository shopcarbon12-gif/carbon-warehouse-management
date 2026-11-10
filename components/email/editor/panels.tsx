"use client";

/**
 * Email editor — the left panel (335 px, like Klaviyo): "Add content" (Basic blocks + layouts,
 * Pre-built CARBON sections), the selected block's settings (Styles / Display tabs), the selected
 * section's settings, and the email's global styles ("Edit styles").
 */
import { useState, type DragEvent, type ReactNode } from "react";
import {
  Columns2,
  Film,
  Code2,
  Image as ImageIcon,
  LayoutPanelTop,
  Minus,
  MoveVertical,
  PanelTop,
  Plus,
  RectangleHorizontal,
  Search,
  Share2,
  ShoppingBag,
  SquareSplitHorizontal,
  Ticket,
  Trash2,
  Type,
  GripVertical,
} from "lucide-react";
import { PREBUILT } from "@/lib/email-editor/prebuilt";
import { picBlocked } from "@/lib/email-editor/render";
import { LAYOUTS, LOGO, uid, type Block, type BlockType, type GlobalStyles, type HeadingKey, type BrandKit, type ProductFeed, type ProductItem, type Section, type SocialNet, type Visibility } from "@/lib/email-editor/types";
import { AlignSeg, BorderGroup, Color, Field, FontRow, Group, Num, OptColor, PadField, Select, Seg, Text, Toggle, inputCls } from "./fields";
import type { Drag } from "./canvas";
import { AiRewrite } from "./ai";

/* --------------------------------------------------------- add content */

const TILES: { type: BlockType; label: string; icon: ReactNode }[] = [
  { type: "text", label: "Text", icon: <Type size={18} /> },
  { type: "image", label: "Image", icon: <ImageIcon size={18} /> },
  { type: "split", label: "Split", icon: <SquareSplitHorizontal size={18} /> },
  { type: "button", label: "Button", icon: <RectangleHorizontal size={18} /> },
  { type: "header", label: "Header bar", icon: <PanelTop size={18} /> },
  { type: "divider", label: "Divider", icon: <Minus size={18} /> },
  { type: "social", label: "Social links", icon: <Share2 size={18} /> },
  { type: "spacer", label: "Spacer", icon: <MoveVertical size={18} /> },
  { type: "product", label: "Product", icon: <ShoppingBag size={18} /> },
  { type: "code", label: "Code", icon: <Ticket size={18} /> },
  { type: "video", label: "Video", icon: <Film size={18} /> },
  { type: "html", label: "HTML", icon: <Code2 size={18} /> },
];

function Tile({ label, icon, onDragStart, onDragEnd, onClick }: { label: string; icon: ReactNode; onDragStart: (e: DragEvent) => void; onDragEnd: () => void; onClick: () => void }) {
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      title={`Drag onto the email (or click to add ${label.toLowerCase()})`}
      className="group relative flex h-[57px] items-center gap-2.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 text-left text-[0.8rem] text-[var(--wms-fg)] hover:border-[var(--wms-accent)] hover:shadow-sm"
    >
      <span className="text-[var(--wms-muted)] group-hover:text-[var(--wms-fg)]">{icon}</span>
      {label}
      <GripVertical size={13} className="absolute right-1.5 text-[var(--wms-muted)] opacity-0 group-hover:opacity-100" />
    </button>
  );
}

export type SavedSection = { id: string; name: string; created_by: string | null; data: Section };

export function AddContentPanel({
  setDrag,
  onAdd,
  onAddLayout,
  onAddPrebuilt,
  saved,
  onAddSaved,
  onDeleteSaved,
}: {
  setDrag: (d: Drag) => void;
  onAdd: (t: BlockType) => void;
  onAddLayout: () => void;
  onAddPrebuilt: (id: string) => void;
  saved: SavedSection[] | null;
  onAddSaved: (id: string) => void;
  onDeleteSaved: (id: string, name: string) => void;
}) {
  const [tab, setTab] = useState<"basic" | "prebuilt" | "saved">("basic");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("All");
  const tags = ["All", ...Array.from(new Set(PREBUILT.flatMap((p) => p.tags)))];
  const start = (d: Drag) => (e: DragEvent) => {
    e.dataTransfer.setData("text/plain", "ce");
    e.dataTransfer.effectAllowed = "copyMove";
    setDrag(d);
  };
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex gap-1 border-b border-[var(--wms-border)] px-4">
        {(
          [
            ["basic", "Basic"],
            ["prebuilt", "Pre-built"],
            ["saved", "Saved"],
          ] as const
        ).map(([t, l]) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-2 py-2.5 text-[0.8rem] ${tab === t ? "border-[var(--wms-accent)] font-semibold text-[var(--wms-fg)]" : "border-transparent text-[var(--wms-muted)]"}`}>
            {l}
          </button>
        ))}
      </div>
      {tab === "basic" ? (
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <div className="flex flex-col gap-2">
            <h4 className="text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Blocks</h4>
            <div className="grid grid-cols-2 gap-2">
              {TILES.map((t) => (
                <Tile key={t.type} label={t.label} icon={t.icon} onDragStart={start({ kind: "new", type: t.type })} onDragEnd={() => setDrag(null)} onClick={() => onAdd(t.type)} />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <h4 className="text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Layout</h4>
            <div className="grid grid-cols-2 gap-2">
              <Tile label="Columns" icon={<Columns2 size={18} />} onDragStart={start({ kind: "layout" })} onDragEnd={() => setDrag(null)} onClick={onAddLayout} />
              <Tile label="Section" icon={<LayoutPanelTop size={18} />} onDragStart={start({ kind: "layout" })} onDragEnd={() => setDrag(null)} onClick={onAddLayout} />
            </div>
          </div>
          <p className="text-[0.72rem] leading-relaxed text-[var(--wms-muted)]">Drag a block onto the email, or click it to add it under the selected block. Double-click text to type in it.</p>
        </div>
      ) : tab === "saved" ? (
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-4">
          {!saved && <p className="text-[0.75rem] text-[var(--wms-muted)]">Loading…</p>}
          {saved && !saved.length && (
            <p className="text-[0.75rem] leading-relaxed text-[var(--wms-muted)]">
              Nothing saved yet. Click a section on the email, then the bookmark button on its toolbar, to keep it here and reuse it in any email (a header, a footer, a store block…).
            </p>
          )}
          {saved?.map((x) => (
            <div key={x.id} className="group flex items-center gap-1">
              <button
                type="button"
                draggable
                onDragStart={start({ kind: "saved", id: x.id })}
                onDragEnd={() => setDrag(null)}
                onClick={() => onAddSaved(x.id)}
                className="flex min-w-0 flex-1 items-center justify-between rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2.5 text-left text-[0.8rem] text-[var(--wms-fg)] hover:border-[var(--wms-accent)]"
              >
                <span className="truncate">{x.name}</span>
                <span className="shrink-0 text-[0.68rem] text-[var(--wms-muted)]">{x.data.cols.length > 1 ? `${x.data.cols.length} columns` : "section"}</span>
              </button>
              <button type="button" title={`Delete “${x.name}”`} aria-label={`Delete ${x.name}`} onClick={() => onDeleteSaved(x.id, x.name)} className="grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--wms-muted)] hover:text-[var(--wms-status-danger-fg)]">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {saved && saved.length > 0 && <p className="text-[0.72rem] leading-relaxed text-[var(--wms-muted)]">Drag one onto the email or click it. Each email gets its own copy, so changing it in one email never changes another.</p>}
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--wms-muted)]" />
            <input className={`${inputCls} pl-7`} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <button key={t} type="button" onClick={() => setTag(t)} className={`rounded-full border px-2.5 py-0.5 text-[0.72rem] ${tag === t ? "border-[var(--wms-accent)] text-[var(--wms-fg)]" : "border-[var(--wms-border)] text-[var(--wms-muted)]"}`}>
                {t}
              </button>
            ))}
          </div>
          {PREBUILT.filter((p) => (tag === "All" || p.tags.includes(tag)) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))).map((p) => (
            <button
              key={p.id}
              type="button"
              draggable
              onDragStart={start({ kind: "prebuilt", id: p.id })}
              onDragEnd={() => setDrag(null)}
              onClick={() => onAddPrebuilt(p.id)}
              className="flex items-center justify-between rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2.5 text-left text-[0.8rem] text-[var(--wms-fg)] hover:border-[var(--wms-accent)]"
            >
              <span>{p.name}</span>
              <span className="text-[0.68rem] text-[var(--wms-muted)]">{p.tags[0]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- shared bits */

function Tabs({ tab, setTab }: { tab: "styles" | "display"; setTab: (t: "styles" | "display") => void }) {
  return (
    <div className="flex gap-1 border-b border-[var(--wms-border)] px-4">
      {(["styles", "display"] as const).map((t) => (
        <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-2 py-2.5 text-[0.8rem] capitalize ${tab === t ? "border-[var(--wms-accent)] font-semibold text-[var(--wms-fg)]" : "border-transparent text-[var(--wms-muted)]"}`}>
          {t}
        </button>
      ))}
    </div>
  );
}

function DisplayTab({ value, onChange, section }: { value: Visibility; onChange: (v: Visibility) => void; section?: boolean }) {
  return (
    <Group title="Visibility">
      <Select
        value={value}
        onChange={onChange}
        options={[
          { v: "all", label: "All devices" },
          { v: "desktop", label: "Desktop only" },
          { v: "mobile", label: "Mobile only" },
        ]}
      />
      <p className="text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">
        {section ? "Hidden parts look faded in the editor and are left out of the email on that kind of screen." : "Hidden blocks look faded in the editor and are left out of the email on that kind of screen."}
      </p>
    </Group>
  );
}

function BlockBasics<T extends Block>({ b, set }: { b: T; set: (p: Partial<T>) => void }) {
  return (
    <>
      <OptColor title="Block background" value={b.bg} onChange={(v) => set({ bg: v } as Partial<T>)} />
      <Group title="Block padding">
        <PadField value={b.pad} onChange={(v) => set({ pad: v } as Partial<T>)} />
        <Toggle label="Full width on mobile" checked={b.fullMobile} onChange={(v) => set({ fullMobile: v } as Partial<T>)} />
      </Group>
    </>
  );
}

function ImageChooser({ src, onPick, onRemove }: { src: string | null; onPick: () => void; onRemove: () => void }) {
  return src ? (
    <div className="flex items-center gap-3">
      <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded border border-[var(--wms-border)] bg-[#f3f3f3]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="max-h-full max-w-full object-contain" />
      </span>
      <div className="flex flex-col gap-1">
        <button type="button" onClick={onPick} className="text-left text-[0.78rem] font-semibold text-[var(--wms-accent)] hover:underline">
          Replace
        </button>
        <button type="button" onClick={onRemove} className="text-left text-[0.78rem] text-[var(--wms-muted)] hover:underline">
          Remove
        </button>
      </div>
    </div>
  ) : (
    <button type="button" onClick={onPick} className="grid h-24 place-items-center rounded border-2 border-dashed border-[var(--wms-border)] text-[0.78rem] text-[var(--wms-muted)] hover:border-[var(--wms-accent)] hover:text-[var(--wms-fg)]">
      Select image
    </button>
  );
}

/* ------------------------------------------------------- block settings */

export type PanelHelpers = {
  pickImage: (cb: (img: { url: string; width: number | null; height: number | null; alt: string }) => void) => void;
  pickProducts: (initial: ProductItem[], cb: (items: ProductItem[]) => void) => void;
  feedItems: (feed: ProductFeed) => Promise<ProductItem[]>;
  /** The words of the whole email (context for "Rewrite with AI"). */
  aiContext: () => string;
};

export function BlockPanel({ block, onChange, h }: { block: Block; onChange: (b: Block, key?: string) => void; h: PanelHelpers }) {
  const [tab, setTab] = useState<"styles" | "display">("styles");
  const set = <T extends Block>(patch: Partial<T>, key = "") => onChange({ ...block, ...patch } as Block, key);
  const b = block;
  let body: ReactNode = null;
  switch (b.type) {
    case "text":
      body = (
        <>
          <Group title="Text">
            <p className="text-[0.72rem] leading-relaxed text-[var(--wms-muted)]">Double-click the text on the email to type. The toolbar on top has headings, bold, colours, links and personal tags like the first name.</p>
          </Group>
          <AiRewrite html={b.html} context={h.aiContext} onUse={(html) => set({ html })} />
          <Group title="Exact font everywhere">
            <Toggle label="Send as a picture" checked={!!b.asPic} onChange={(v) => set({ asPic: v })} />
            <p className="text-[0.72rem] leading-relaxed text-[var(--wms-muted)]">
              Gmail and Outlook show a stand-in font. Switched on, this text is sent as a sharp picture of exactly what you see, with the words underneath for people who turn pictures off.
              Spanish and Portuguese copies get their own picture. Use it for headlines, not paragraphs.
            </p>
            {b.asPic && picBlocked(b.html) && <p className="text-[0.72rem] leading-relaxed text-[var(--wms-status-warning-fg)]">Sent as text for now: {picBlocked(b.html)}</p>}
          </Group>
          <Group title="Text area">
            <PadField label="Text area padding" value={b.areaPad} onChange={(v) => set({ areaPad: v })} />
          </Group>
          <OptColor title="Text area background" value={b.areaBg} onChange={(v) => set({ areaBg: v })} />
          <BorderGroup value={b.border} onChange={(v) => set({ border: v })} />
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "image":
      body = (
        <>
          <Group title="Image">
            <ImageChooser src={b.src} onPick={() => h.pickImage((i) => set({ src: i.url, natW: i.width, natH: i.height, alt: b.alt || i.alt }))} onRemove={() => set({ src: null })} />
            <Field label="Alt text">
              <Text value={b.alt} onChange={(v) => set({ alt: v }, "alt")} placeholder="Describe the picture" />
            </Field>
            <Field label="Link address">
              <Text value={b.href} onChange={(v) => set({ href: v }, "href")} placeholder="https://shopcarbon.com/…" />
            </Field>
          </Group>
          <Group title="Image layout">
            <Toggle label="Fill column" checked={b.fill} onChange={(v) => set({ fill: v })} />
            {!b.fill && (
              <Field label="Width" inline>
                <Num value={b.width ?? b.natW ?? 300} onChange={(v) => set({ width: v }, "w")} max={1200} />
              </Field>
            )}
            <Toggle label="Fill column on mobile" checked={b.fillMobile} onChange={(v) => set({ fillMobile: v })} />
            <Field label="Alignment" inline>
              <AlignSeg value={b.align} onChange={(v) => set({ align: v })} />
            </Field>
            <Field label="Corner radius" inline>
              <Num value={b.radius} onChange={(v) => set({ radius: v }, "r")} max={200} />
            </Field>
          </Group>
          <BorderGroup value={b.border} onChange={(v) => set({ border: v })} />
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "split":
      body = (
        <>
          {b.cells.map((c, i) => (
            <Group key={i} title={`Column ${i + 1}`}>
              <Select
                value={c.kind}
                onChange={(k) => {
                  const cells = [...b.cells] as typeof b.cells;
                  cells[i] = k === "text" ? { kind: "text", html: "<p>Double-click to edit this text.</p>" } : k === "image" ? { kind: "image", src: null, alt: "", href: "" } : { kind: "html", code: "<p>HTML</p>" };
                  set({ cells });
                }}
                options={[
                  { v: "text", label: "Text" },
                  { v: "image", label: "Image" },
                  { v: "html", label: "HTML" },
                ]}
              />
              {c.kind === "text" && (
                <Field label="Text (HTML)">
                  <Text area value={c.html} onChange={(v) => {
                    const cells = [...b.cells] as typeof b.cells;
                    cells[i] = { kind: "text", html: v };
                    set({ cells }, `cell${i}`);
                  }} />
                </Field>
              )}
              {c.kind === "image" && (
                <>
                  <ImageChooser
                    src={c.src}
                    onPick={() =>
                      h.pickImage((img) => {
                        const cells = [...b.cells] as typeof b.cells;
                        cells[i] = { ...c, src: img.url, alt: c.alt || img.alt };
                        set({ cells });
                      })
                    }
                    onRemove={() => {
                      const cells = [...b.cells] as typeof b.cells;
                      cells[i] = { ...c, src: null };
                      set({ cells });
                    }}
                  />
                  <Field label="Link address">
                    <Text value={c.href} onChange={(v) => {
                      const cells = [...b.cells] as typeof b.cells;
                      cells[i] = { ...c, href: v };
                      set({ cells }, `href${i}`);
                    }} />
                  </Field>
                </>
              )}
              {c.kind === "html" && (
                <Text area value={c.code} onChange={(v) => {
                  const cells = [...b.cells] as typeof b.cells;
                  cells[i] = { kind: "html", code: v };
                  set({ cells }, `code${i}`);
                }} />
              )}
            </Group>
          ))}
          <Group title="Layout">
            <Field label="Column 1 width" inline>
              <Num value={b.widths[0]} unit="%" min={10} max={90} onChange={(v) => set({ widths: [v, 100 - v] }, "w")} />
            </Field>
            <Field label="Spacing" inline>
              <Num value={b.spacing} onChange={(v) => set({ spacing: v }, "sp")} max={120} />
            </Field>
            <Field label="Vertical alignment" inline>
              <Select value={b.valign} onChange={(v) => set({ valign: v })} options={[{ v: "top", label: "Top" }, { v: "middle", label: "Middle" }, { v: "bottom", label: "Bottom" }]} />
            </Field>
            <Field label="Mobile stacking">
              <Select value={b.stack} onChange={(v) => set({ stack: v })} options={[{ v: "left-first", label: "Left column on top" }, { v: "right-first", label: "Right column on top" }, { v: "none", label: "No stacking" }]} />
            </Field>
          </Group>
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "button":
      body = (
        <>
          <Group title="Button text">
            <Field label="Text">
              <Text value={b.text} onChange={(v) => set({ text: v }, "text")} />
            </Field>
            <Field label="Link address">
              <Text value={b.href} onChange={(v) => set({ href: v }, "href")} placeholder="https://shopcarbon.com/…" />
            </Field>
            <FontRow value={b.font} onChange={(v) => set({ font: v }, "font")} />
          </Group>
          <Group title="Style">
            <Field label="Color" inline>
              <Color value={b.color} onChange={(v) => set({ color: v }, "color")} />
            </Field>
            <Field label="Corner radius" inline>
              <Num value={b.radius} onChange={(v) => set({ radius: v }, "r")} max={60} />
            </Field>
            <Field label="Width" inline>
              <Seg value={b.full ? "full" : "fit"} onChange={(v) => set({ full: v === "full" })} options={[{ v: "fit", label: "Fit to text", title: "Fit to text" }, { v: "full", label: "Full width", title: "Full width" }]} />
            </Field>
            {!b.full && (
              <Field label="Alignment" inline>
                <AlignSeg value={b.align} onChange={(v) => set({ align: v })} />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Padding top/bottom">
                <Num value={b.btnPad.v} onChange={(v) => set({ btnPad: { ...b.btnPad, v } }, "bp")} width="w-full" max={60} />
              </Field>
              <Field label="Padding sides">
                <Num value={b.btnPad.h} onChange={(v) => set({ btnPad: { ...b.btnPad, h: v } }, "bp")} width="w-full" max={120} />
              </Field>
            </div>
          </Group>
          <BorderGroup value={b.border} onChange={(v) => set({ border: v })} />
          <OptColor title="Drop shadow" value={b.shadow} onChange={(v) => set({ shadow: v })} fallback="#00000033" />
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "header":
      body = (
        <>
          <Group title="Logo">
            <ImageChooser src={b.logo} onPick={() => h.pickImage((i) => set({ logo: i.url }))} onRemove={() => set({ logo: null })} />
            <div className="flex gap-2">
              <button type="button" className="text-[0.75rem] text-[var(--wms-accent)] hover:underline" onClick={() => set({ logo: LOGO.black })}>
                Black logo
              </button>
              <button type="button" className="text-[0.75rem] text-[var(--wms-accent)] hover:underline" onClick={() => set({ logo: LOGO.white })}>
                White logo
              </button>
            </div>
            <Field label="Max width" inline>
              <Num value={b.logoWidth} onChange={(v) => set({ logoWidth: v }, "lw")} min={40} max={560} />
            </Field>
            <Field label="Logo link">
              <Text value={b.logoHref} onChange={(v) => set({ logoHref: v }, "lh")} />
            </Field>
          </Group>
          <Group title="Layout">
            <Field label="Desktop layout">
              <Select value={b.layout} onChange={(v) => set({ layout: v })} options={[{ v: "stacked", label: "Logo stacked" }, { v: "inline", label: "Logo inline" }, { v: "centered", label: "Logo centered" }, { v: "links", label: "Links only" }]} />
            </Field>
            <Field label="Mobile layout">
              <Select value={b.mobileLayout} onChange={(v) => set({ mobileLayout: v })} options={[{ v: "stack", label: "Stack all" }, { v: "inline", label: "Logo inline" }, { v: "links", label: "Links only" }]} />
            </Field>
            <Field label="Alignment" inline>
              <AlignSeg value={b.align} onChange={(v) => set({ align: v })} />
            </Field>
          </Group>
          <Group title="Links">
            {b.links.map((l, i) => (
              <div key={l.id} className="flex flex-col gap-1 rounded border border-[var(--wms-border)] p-2">
                <div className="flex items-center gap-1">
                  <input className={inputCls} value={l.text} aria-label="Link text" onChange={(e) => set({ links: b.links.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) }, `lt${i}`)} />
                  <button type="button" aria-label="Remove link" className="grid h-8 w-8 shrink-0 place-items-center text-[var(--wms-muted)] hover:text-[var(--wms-status-danger-fg)]" onClick={() => set({ links: b.links.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </button>
                </div>
                <input className={inputCls} value={l.href} aria-label="Link address" onChange={(e) => set({ links: b.links.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)) }, `lh${i}`)} />
              </div>
            ))}
            <button type="button" className="inline-flex items-center gap-1 text-[0.78rem] font-semibold text-[var(--wms-accent)]" onClick={() => set({ links: [...b.links, { id: uid(), text: "LINK", href: "https://shopcarbon.com" }] })}>
              <Plus size={14} /> Add link
            </button>
          </Group>
          <Group title="Link text">
            <FontRow value={b.linkFont} onChange={(v) => set({ linkFont: v }, "lf")} />
          </Group>
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "divider":
      body = (
        <>
          <Group title="Line">
            <Field label="Style" inline>
              <Select value={b.style} onChange={(v) => set({ style: v })} options={[{ v: "solid", label: "Solid" }, { v: "dashed", label: "Dashed" }, { v: "dotted", label: "Dotted" }]} />
            </Field>
            <Field label="Thickness" inline>
              <Num value={b.width} onChange={(v) => set({ width: v }, "w")} max={20} />
            </Field>
            <Field label="Length" inline>
              <Num value={b.lineWidth} unit="%" min={5} max={100} onChange={(v) => set({ lineWidth: v }, "lw")} />
            </Field>
            <Field label="Color" inline>
              <Color value={b.color} onChange={(v) => set({ color: v }, "c")} />
            </Field>
          </Group>
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "spacer":
      body = (
        <>
          <Group title="Spacer">
            <Field label="Height" inline>
              <Num value={b.height} onChange={(v) => set({ height: v }, "h")} max={400} />
            </Field>
          </Group>
          <OptColor title="Background color" value={b.bg} onChange={(v) => set({ bg: v })} />
        </>
      );
      break;
    case "social":
      body = (
        <>
          <Group title="Icons">
            {b.items.map((it, i) => (
              <div key={it.id} className="flex flex-col gap-1 rounded border border-[var(--wms-border)] p-2">
                <div className="flex items-center gap-1">
                  <Select<SocialNet>
                    value={it.net}
                    onChange={(v) => set({ items: b.items.map((x, j) => (j === i ? { ...x, net: v } : x)) })}
                    options={[{ v: "instagram", label: "Instagram" }, { v: "facebook", label: "Facebook" }, { v: "tiktok", label: "TikTok" }, { v: "youtube", label: "YouTube" }, { v: "website", label: "Website" }]}
                  />
                  <button type="button" aria-label="Remove icon" className="grid h-8 w-8 shrink-0 place-items-center text-[var(--wms-muted)] hover:text-[var(--wms-status-danger-fg)]" onClick={() => set({ items: b.items.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </button>
                </div>
                <input className={inputCls} value={it.href} aria-label="Link address" onChange={(e) => set({ items: b.items.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)) }, `sh${i}`)} />
                {b.showLabels && <input className={inputCls} value={it.label} aria-label="Label" onChange={(e) => set({ items: b.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }, `sl${i}`)} />}
              </div>
            ))}
            <button type="button" className="inline-flex items-center gap-1 text-[0.78rem] font-semibold text-[var(--wms-accent)]" onClick={() => set({ items: [...b.items, { id: uid(), net: "website", href: "https://shopcarbon.com", label: "Website" }] })}>
              <Plus size={14} /> Add icon
            </button>
          </Group>
          <Group title="Icon styles">
            <Field label="Size" inline>
              <Seg value={b.size} onChange={(v) => set({ size: v })} options={[{ v: "s", label: "S", title: "Small" }, { v: "m", label: "M", title: "Medium" }, { v: "l", label: "L", title: "Large" }]} />
            </Field>
            <Field label="Color" inline>
              <Select value={b.color} onChange={(v) => set({ color: v })} options={[{ v: "black", label: "Black" }, { v: "grey", label: "Grey" }, { v: "white", label: "White" }, { v: "brand", label: "Brand colours" }]} />
            </Field>
            <Field label="Alignment" inline>
              <AlignSeg value={b.align} onChange={(v) => set({ align: v })} />
            </Field>
            <Field label="Spacing" inline>
              <Num value={b.spacing} onChange={(v) => set({ spacing: v }, "sp")} max={60} />
            </Field>
            <Toggle label="Text labels" checked={b.showLabels} onChange={(v) => set({ showLabels: v })} />
            {b.showLabels && <FontRow value={b.labelFont} onChange={(v) => set({ labelFont: v }, "lf")} />}
          </Group>
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "product":
      body = (
        <>
          <Group title="Product selection">
            <Seg
              value={b.source}
              onChange={async (v) => {
                if (v === "dynamic") set({ source: v, items: await h.feedItems(b.feed) });
                else set({ source: v, items: [] });
              }}
              options={[{ v: "dynamic", label: "Dynamic", title: "Products picked automatically" }, { v: "static", label: "Static", title: "Products you choose" }]}
            />
            {b.source === "dynamic" ? (
              <>
                <Field label="Show">
                  <Select<ProductFeed>
                    value={b.feed}
                    onChange={async (v) => set({ feed: v, items: await h.feedItems(v) })}
                    options={[{ v: "newest", label: "Newest arrivals" }, { v: "women", label: "Newest for women" }, { v: "men", label: "Newest for men" }, { v: "most-stock", label: "Most in stock" }]}
                  />
                </Field>
                <Field label="Start with item number" inline>
                  <Num value={b.startAt} unit="" min={1} max={30} onChange={(v) => set({ startAt: v }, "st")} />
                </Field>
                <p className="text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">Only products with stock. The list is refreshed each time the email is opened here.</p>
              </>
            ) : (
              <>
                {b.items.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {b.items.map((p, i) => (
                      <li key={p.id} className="flex items-center gap-2 rounded border border-[var(--wms-border)] p-1.5 text-[0.75rem] text-[var(--wms-fg)]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {p.image && <img src={p.image} alt="" className="h-10 w-8 rounded-sm object-cover" />}
                        <span className="min-w-0 flex-1 truncate">{p.title}</span>
                        <button type="button" aria-label="Move up" disabled={i === 0} className="px-1 text-[var(--wms-muted)] disabled:opacity-30" onClick={() => {
                          const items = [...b.items];
                          [items[i - 1], items[i]] = [items[i], items[i - 1]];
                          set({ items });
                        }}>
                          ↑
                        </button>
                        <button type="button" aria-label="Remove" className="px-1 text-[var(--wms-muted)] hover:text-[var(--wms-status-danger-fg)]" onClick={() => set({ items: b.items.filter((x) => x.id !== p.id) })}>
                          <Trash2 size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="h-8 rounded border border-[var(--wms-border)] text-[0.78rem] font-semibold text-[var(--wms-fg)] hover:border-[var(--wms-accent)]" onClick={() => h.pickProducts(b.items, (items) => set({ items }))}>
                  {b.items.length ? "Change products" : "Add products"}
                </button>
              </>
            )}
          </Group>
          <Group title="Show">
            <Toggle label="Product name" checked={b.showName} onChange={(v) => set({ showName: v })} />
            <Toggle label="Price" checked={b.showPrice} onChange={(v) => set({ showPrice: v })} />
            <Toggle label="Original price for sale products" checked={b.showCompare} onChange={(v) => set({ showCompare: v })} />
            <Toggle label="Button" checked={b.showButton} onChange={(v) => set({ showButton: v })} />
            {b.showButton && (
              <Field label="Button text">
                <Text value={b.buttonText} onChange={(v) => set({ buttonText: v }, "bt")} />
              </Field>
            )}
          </Group>
          <Group title="Layout">
            <Field label="Orientation">
              <Select value={b.orientation} onChange={(v) => set({ orientation: v })} options={[{ v: "vertical", label: "Picture on top" }, { v: "image-left", label: "Picture left" }, { v: "image-right", label: "Picture right" }]} />
            </Field>
            <Field label="Products per row" inline>
              <Num value={b.perRow} unit="" min={1} max={6} onChange={(v) => set({ perRow: v }, "pr")} />
            </Field>
            {b.source === "dynamic" && (
              <Field label="Number of rows" inline>
                <Num value={b.rows} unit="" min={1} max={6} onChange={(v) => set({ rows: v }, "rows")} />
              </Field>
            )}
            <Field label="Picture shape" inline>
              <Select value={b.imgRatio} onChange={(v) => set({ imgRatio: v })} options={[{ v: "4:5", label: "4:5 (like the shop)" }, { v: "1:1", label: "Square" }, { v: "auto", label: "As the photo" }]} />
            </Field>
            <Field label="Alignment" inline>
              <AlignSeg value={b.align} onChange={(v) => set({ align: v })} />
            </Field>
            <Field label="Space between" inline>
              <Num value={b.gap} onChange={(v) => set({ gap: v }, "gap")} max={60} />
            </Field>
            <p className="text-[0.7rem] text-[var(--wms-muted)]">On phones, 3 or more per row become 2 per row.</p>
          </Group>
          {b.showName && (
            <Group title="Name text">
              <FontRow value={b.nameFont} onChange={(v) => set({ nameFont: v }, "nf")} />
            </Group>
          )}
          {b.showPrice && (
            <Group title="Price text">
              <FontRow value={b.priceFont} onChange={(v) => set({ priceFont: v }, "pf")} />
            </Group>
          )}
          {b.showButton && (
            <Group title="Button">
              <FontRow value={b.btnFont} onChange={(v) => set({ btnFont: v }, "bf")} />
              <Field label="Button color" inline>
                <Color value={b.btnColor} onChange={(v) => set({ btnColor: v }, "bc")} />
              </Field>
              <Field label="Corner radius" inline>
                <Num value={b.btnRadius} onChange={(v) => set({ btnRadius: v }, "br")} max={40} />
              </Field>
            </Group>
          )}
          <BorderGroup title="Product border" value={b.border} onChange={(v) => set({ border: v })} />
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "code":
      body = (
        <>
          <Group title="Code">
            <p className="text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">Each person gets their own Shopify code here. The campaign sets the offer ($ or % off) and the end date.</p>
            <Field label="Title above the code">
              <Text value={b.title} onChange={(v) => set({ title: v }, "t")} />
            </Field>
            <Field label="Text under the code">
              <Text value={b.note} onChange={(v) => set({ note: v }, "n")} />
            </Field>
            <p className="text-[0.68rem] text-[var(--wms-muted)]">{"{{offer_amount}}"} = the offer, {"{{offer_ends}}"} = the end date.</p>
          </Group>
          <Group title="Code box">
            <FontRow value={b.codeFont} onChange={(v) => set({ codeFont: v }, "cf")} />
            <Field label="Box color" inline>
              <Color value={b.boxBg} onChange={(v) => set({ boxBg: v }, "bb")} />
            </Field>
            <Field label="Alignment" inline>
              <AlignSeg value={b.align} onChange={(v) => set({ align: v })} />
            </Field>
          </Group>
          <BorderGroup title="Box border" value={b.boxBorder} onChange={(v) => set({ boxBorder: v })} />
          <Group title="Title text">
            <FontRow value={b.titleFont} onChange={(v) => set({ titleFont: v }, "tf")} />
          </Group>
          <Group title="Button" optional={{ on: b.button, toggle: () => set({ button: !b.button }) }}>
            <Field label="Text">
              <Text value={b.buttonText} onChange={(v) => set({ buttonText: v }, "bt")} />
            </Field>
            <Field label="Button color" inline>
              <Color value={b.btnColor} onChange={(v) => set({ btnColor: v }, "bc")} />
            </Field>
            <FontRow value={b.btnFont} onChange={(v) => set({ btnFont: v }, "bf")} />
          </Group>
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "video":
      body = (
        <>
          <Group title="Video">
            <Field label="Video link (YouTube, Instagram, TikTok …)">
              <Text value={b.href} onChange={(v) => set({ href: v }, "href")} placeholder="https://…" />
            </Field>
            <p className="text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">Email apps don&apos;t play video: the email shows the thumbnail picture, and a tap opens the video.</p>
            <ImageChooser src={b.thumb} onPick={() => h.pickImage((i) => set({ thumb: i.url }))} onRemove={() => set({ thumb: null })} />
            <Field label="Caption">
              <Text value={b.alt} onChange={(v) => set({ alt: v }, "alt")} />
            </Field>
            <Field label="Corner radius" inline>
              <Num value={b.radius} onChange={(v) => set({ radius: v }, "r")} max={60} />
            </Field>
          </Group>
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
    case "html":
      body = (
        <>
          <Group title="HTML">
            <textarea className={`${inputCls} h-64 py-2 font-mono text-[0.72rem] leading-relaxed`} spellCheck={false} value={b.code} onChange={(e) => set({ code: e.target.value }, "code")} />
            <p className="text-[0.7rem] text-[var(--wms-muted)]">Scripts, forms and frames are removed when the email is saved.</p>
          </Group>
          <BlockBasics b={b} set={set} />
        </>
      );
      break;
  }
  return (
    <div className="flex min-h-0 flex-col">
      <Tabs tab={tab} setTab={setTab} />
      <div className="min-h-0 overflow-y-auto">{tab === "styles" ? body : <DisplayTab value={b.visibility} onChange={(v) => set({ visibility: v })} />}</div>
    </div>
  );
}

/* ------------------------------------------------------ section settings */

export function SectionPanel({ section, onChange, onLayout, pickImage }: { section: Section; onChange: (s: Section, key?: string) => void; onLayout: (widths: number[]) => void; pickImage: PanelHelpers["pickImage"] }) {
  const [tab, setTab] = useState<"styles" | "display">("styles");
  const s = section;
  const set = (p: Partial<Section>, key = "") => onChange({ ...s, ...p }, key);
  const n = s.cols.length;
  return (
    <div className="flex min-h-0 flex-col">
      <Tabs tab={tab} setTab={setTab} />
      <div className="min-h-0 overflow-y-auto">
        {tab === "display" ? (
          <DisplayTab section value={s.visibility} onChange={(v) => set({ visibility: v })} />
        ) : (
          <>
            <Group title="Columns">
              <div className="inline-flex w-fit rounded border border-[var(--wms-border)] p-0.5">
                {[1, 2, 3, 4].map((k) => (
                  <button key={k} type="button" onClick={() => onLayout(LAYOUTS[k][0])} className={`h-7 w-9 rounded text-[0.8rem] ${n === k ? "bg-[var(--wms-surface-elevated)] font-semibold text-[var(--wms-fg)]" : "text-[var(--wms-muted)]"}`}>
                    {k}
                  </button>
                ))}
              </div>
              {LAYOUTS[n].length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {LAYOUTS[n].map((ws) => {
                    const on = ws.every((w, i) => Math.round(w) === Math.round(s.cols[i]?.w ?? 0));
                    return (
                      <button key={ws.join("-")} type="button" onClick={() => onLayout(ws)} className={`flex h-8 w-16 gap-0.5 rounded border p-1 ${on ? "border-[var(--wms-accent)]" : "border-[var(--wms-border)]"}`} title={ws.map((w) => `${Math.round(w)}%`).join(" | ")}>
                        {ws.map((w, j) => (
                          <span key={j} className="rounded-sm bg-[var(--wms-border)]" style={{ width: `${w}%` }} />
                        ))}
                      </button>
                    );
                  })}
                </div>
              )}
              {n > 1 && (
                <>
                  <Field label="Space between columns" inline>
                    <Num value={s.gap} onChange={(v) => set({ gap: v }, "gap")} max={80} />
                  </Field>
                  <Field label="Column content alignment" inline>
                    <Select value={s.valign} onChange={(v) => set({ valign: v })} options={[{ v: "top", label: "Top" }, { v: "middle", label: "Center" }, { v: "bottom", label: "Bottom" }]} />
                  </Field>
                  <Field label="Mobile stacking">
                    <Select value={s.stack} onChange={(v) => set({ stack: v })} options={[{ v: "left-first", label: "Left column on top" }, { v: "right-first", label: "Right column on top" }, { v: "none", label: "No stacking" }]} />
                  </Field>
                </>
              )}
            </Group>
            <Group title="Background image" optional={{ on: !!s.bgImage, toggle: () => (s.bgImage ? set({ bgImage: null }) : pickImage((i) => set({ bgImage: i.url }))) }}>
              {s.bgImage && <ImageChooser src={s.bgImage} onPick={() => pickImage((i) => set({ bgImage: i.url }))} onRemove={() => set({ bgImage: null })} />}
              <p className="text-[0.7rem] text-[var(--wms-muted)]">Some Outlook versions don&apos;t show background pictures: also set a section colour.</p>
            </Group>
            <OptColor title="Section color" value={s.bg} onChange={(v) => set({ bg: v }, "bg")} />
            <OptColor title="Content color" value={s.contentBg} onChange={(v) => set({ contentBg: v }, "cbg")} fallback="#FFFFFF" />
            <Group title="Padding">
              <PadField value={s.pad} onChange={(v) => set({ pad: v }, "pad")} />
            </Group>
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- global styles */

const HEADINGS: { k: HeadingKey; label: string }[] = [
  { k: "body", label: "Body" },
  { k: "h1", label: "Heading 1" },
  { k: "h2", label: "Heading 2" },
  { k: "h3", label: "Heading 3" },
  { k: "h4", label: "Heading 4" },
];

export type KitState = { kit: BrandKit | null; busy: boolean; msg: string | null };

export function StylesPanel({
  styles,
  onChange,
  kit,
  onApplyKit,
  onSaveKit,
  onKitColors,
}: {
  styles: GlobalStyles;
  onChange: (s: GlobalStyles, key?: string) => void;
  kit: KitState;
  onApplyKit: () => void;
  onSaveKit: () => void;
  onKitColors: (colors: string[]) => void;
}) {
  const [k, setK] = useState<HeadingKey>("body");
  const [add, setAdd] = useState("#111111");
  const s = styles;
  const set = (p: Partial<GlobalStyles>, key = "") => onChange({ ...s, ...p }, key);
  const t = s.text[k];
  const same = !!kit.kit && JSON.stringify(kit.kit.styles) === JSON.stringify(s);
  return (
    <div className="min-h-0 overflow-y-auto">
      <Group title="Brand kit">
        <p className="text-[0.72rem] leading-relaxed text-[var(--wms-muted)]">
          {kit.kit
            ? same
              ? "This email uses your brand kit."
              : "Your saved fonts, colours, buttons and page look. New blank emails start with them."
            : "Save this email's styles as your brand kit: new blank emails start with them, and any email can use them in one click."}
        </p>
        <div className="flex flex-wrap gap-2">
          {kit.kit && !same && (
            <button type="button" disabled={kit.busy} onClick={onApplyKit} className="h-8 rounded bg-[var(--wms-accent)] px-3 text-[0.75rem] font-semibold text-[var(--wms-accent-fg)] disabled:opacity-50">
              Use brand kit here
            </button>
          )}
          {!same && (
            <button type="button" disabled={kit.busy} onClick={onSaveKit} className="h-8 rounded border border-[var(--wms-border)] px-3 text-[0.75rem] font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50">
              {kit.kit ? "Save these styles as the brand kit" : "Save as brand kit"}
            </button>
          )}
        </div>
        {kit.kit && (
          <div className="flex flex-col gap-2">
            <span className="text-[0.72rem] text-[var(--wms-muted)]">Brand colours (the round button in every colour field)</span>
            <div className="flex flex-wrap gap-1.5">
              {kit.kit.colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={`${c}: click to remove`}
                  aria-label={`Remove ${c}`}
                  disabled={kit.busy}
                  onClick={() => onKitColors(kit.kit!.colors.filter((x) => x !== c))}
                  className="group relative h-7 w-7 rounded border border-[var(--wms-border)]"
                  style={{ background: c }}
                >
                  <span className="absolute inset-0 hidden place-items-center rounded bg-black/40 text-[0.7rem] text-white group-hover:grid">×</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Color value={add} onChange={setAdd} />
              <button
                type="button"
                disabled={kit.busy || kit.kit.colors.length >= 24 || kit.kit.colors.includes(add.toUpperCase())}
                onClick={() => onKitColors([...kit.kit!.colors, add.toUpperCase()])}
                className="h-8 rounded border border-[var(--wms-border)] px-2.5 text-[0.75rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
              >
                Add colour
              </button>
            </div>
          </div>
        )}
        {kit.msg && <p className="text-[0.72rem] text-[var(--wms-muted)]">{kit.msg}</p>}
      </Group>
      <Group title="Email">
        <Field label="Page background" inline>
          <Color value={s.pageBg} onChange={(v) => set({ pageBg: v }, "pbg")} />
        </Field>
        <Field label="Content background" inline>
          <Color value={s.contentBg} onChange={(v) => set({ contentBg: v }, "cbg")} />
        </Field>
        <Field label="Width" inline>
          <Num value={s.width} onChange={(v) => set({ width: v }, "w")} min={480} max={800} />
        </Field>
        <Field label="Corner radius" inline>
          <Num value={s.radius} onChange={(v) => set({ radius: v }, "r")} max={40} />
        </Field>
        <Field label="Margin top" inline>
          <Num value={s.marginTop} onChange={(v) => set({ marginTop: v }, "mt")} max={120} />
        </Field>
        <PadField value={s.pad} onChange={(v) => set({ pad: v }, "pad")} />
      </Group>
      <BorderGroup value={s.border} onChange={(v) => set({ border: v })} />
      <Group title="Text and headings">
        <Select value={k} onChange={setK} options={HEADINGS.map((h) => ({ v: h.k, label: h.label }))} />
        <FontRow value={t} onChange={(f) => set({ text: { ...s.text, [k]: { ...t, ...f } } }, `t${k}`)} />
        <Field label="Line height" inline>
          <Select
            value={String(t.lh)}
            onChange={(v) => set({ text: { ...s.text, [k]: { ...t, lh: Number(v) } } })}
            options={["1", "1.1", "1.15", "1.2", "1.3", "1.4", "1.5", "1.6", "2"].map((x) => ({ v: x, label: x }))}
          />
        </Field>
        <Field label="Alignment" inline>
          <AlignSeg value={t.align} onChange={(v) => set({ text: { ...s.text, [k]: { ...t, align: v } } })} />
        </Field>
      </Group>
      <Group title="Links">
        <Field label="Color" inline>
          <Color value={s.link.color} onChange={(v) => set({ link: { ...s.link, color: v } }, "lc")} />
        </Field>
        <Toggle label="Bold" checked={s.link.bold} onChange={(v) => set({ link: { ...s.link, bold: v } })} />
        <Toggle label="Italic" checked={s.link.italic} onChange={(v) => set({ link: { ...s.link, italic: v } })} />
        <Toggle label="Underline" checked={s.link.underline} onChange={(v) => set({ link: { ...s.link, underline: v } })} />
      </Group>
      <Group title="Mobile">
        <Field label="Side margin" inline>
          <Num value={s.mobile.margin} onChange={(v) => set({ mobile: { ...s.mobile, margin: v } }, "mm")} max={40} />
        </Field>
        {HEADINGS.map((h) => (
          <Field key={h.k} label={`${h.label} size`} inline>
            <Num value={s.mobile.sizes[h.k]} min={8} max={80} onChange={(v) => set({ mobile: { ...s.mobile, sizes: { ...s.mobile.sizes, [h.k]: v } } }, `ms${h.k}`)} />
          </Field>
        ))}
      </Group>
    </div>
  );
}
