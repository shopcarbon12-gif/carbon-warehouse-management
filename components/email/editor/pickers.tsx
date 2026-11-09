"use client";

/**
 * Email editor — dialogs: the image picker (Klaviyo: Image library / Upload / Import URL / Product
 * images), the product picker ("Browse products", up to 9, sets as one card), and "Configure column
 * layout" (1–4 columns and their width splits).
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import { Check, Search, Upload, X } from "lucide-react";
import { LAYOUTS, type ProductItem } from "@/lib/email-editor/types";
import { inputCls } from "./fields";

const fetcher = async <T,>(u: string): Promise<T> => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
};

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label={title}>
      <div className={`flex max-h-[88vh] w-full flex-col overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl ${wide ? "max-w-5xl" : "max-w-xl"}`}>
        <header className="flex items-center justify-between border-b border-[var(--wms-border)] px-5 py-3">
          <h3 className="text-[0.95rem] font-semibold text-[var(--wms-fg)]">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-[var(--wms-border)] px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export const primaryBtn = "h-8 rounded bg-[var(--wms-accent)] px-3.5 text-[0.8rem] font-semibold text-[var(--wms-accent-fg)] disabled:opacity-50";
export const ghostBtn = "h-8 rounded border border-[var(--wms-border)] px-3.5 text-[0.8rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50";

/* ------------------------------------------------------------- images */

type LibImage = { url: string; name: string; width: number | null; height: number | null; kind: "upload" | "brand" | "store" | "logo" };
type Catalog = { products: (ProductItem & { gender: string; type: string; stock: number })[]; sets: (ProductItem & { gender: string; type: string; stock: number })[] };

export type PickedImage = { url: string; width: number | null; height: number | null; alt: string };

export function ImagePicker({ onClose, onPick }: { onClose: () => void; onPick: (img: PickedImage) => void }) {
  const [tab, setTab] = useState<"library" | "products" | "url">("library");
  const lib = useSWR<{ images: LibImage[] }>("/api/email/editor/media", fetcher);
  const cat = useSWR<Catalog>(tab === "products" ? "/api/email/editor/catalog" : null, fetcher);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | LibImage["kind"]>("all");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function upload(f: File) {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/email/editor/media", { method: "POST", body: fd });
      const j = (await r.json()) as { image?: LibImage; error?: string };
      if (!r.ok || !j.image) throw new Error(j.error || `HTTP ${r.status}`);
      await lib.mutate();
      onPick({ url: j.image.url, width: j.image.width, height: j.image.height, alt: "" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const images = (lib.data?.images ?? []).filter((i) => (kind === "all" || i.kind === kind) && (!q || i.name.toLowerCase().includes(q.toLowerCase())));
  const products = (cat.data?.products ?? []).filter((p) => p.image && (!q || p.title.toLowerCase().includes(q.toLowerCase())));
  const tabBtn = (t: typeof tab, l: string) => (
    <button type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-[0.8rem] ${tab === t ? "border-[var(--wms-accent)] font-semibold text-[var(--wms-fg)]" : "border-transparent text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"}`}>
      {l}
    </button>
  );
  return (
    <Modal title="Select an image" onClose={onClose} wide>
      <div className="flex gap-1 border-b border-[var(--wms-border)] px-5">
        {tabBtn("library", "Image library")}
        {tabBtn("products", "Product images")}
        {tabBtn("url", "Import URL")}
      </div>
      <div className="flex flex-col gap-3 p-5">
        {tab !== "url" && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--wms-muted)]" />
              <input className={`${inputCls} pl-7`} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {tab === "library" && (
              <>
                <select className={`${inputCls} w-44`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Show">
                  <option value="all">All pictures</option>
                  <option value="upload">Uploaded here</option>
                  <option value="brand">CARBON pictures (Shopify)</option>
                  <option value="store">Store photos</option>
                  <option value="logo">Logo</option>
                </select>
                <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                <button type="button" className={primaryBtn} disabled={busy} onClick={() => file.current?.click()}>
                  <span className="inline-flex items-center gap-1.5">
                    <Upload size={14} /> {busy ? "Uploading…" : "Upload image"}
                  </span>
                </button>
              </>
            )}
          </div>
        )}
        {err && <p className="text-[0.8rem] text-[var(--wms-status-danger-fg)]">{err}</p>}
        {tab === "library" && (
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) upload(f);
            }}
          >
            {lib.isLoading && <p className="text-[0.8rem] text-[var(--wms-muted)]">Loading pictures…</p>}
            {images.map((i) => (
              <button key={i.url} type="button" onClick={() => onPick({ url: i.url, width: i.width, height: i.height, alt: i.kind === "logo" ? "CARBON" : "" })} className="group flex flex-col gap-1 text-left">
                <span className={`grid aspect-square w-full place-items-center overflow-hidden rounded border border-[var(--wms-border)] ${i.url.includes("white") ? "bg-[#333]" : "bg-[#f3f3f3]"} group-hover:border-[var(--wms-accent)]`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={i.url} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
                </span>
                <span className="line-clamp-2 text-[0.7rem] text-[var(--wms-muted)]">{i.name}</span>
              </button>
            ))}
            {!lib.isLoading && !images.length && <p className="text-[0.8rem] text-[var(--wms-muted)]">No pictures. Upload one, or drop a file here.</p>}
          </div>
        )}
        {tab === "products" && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3">
            {cat.isLoading && <p className="text-[0.8rem] text-[var(--wms-muted)]">Loading the catalog…</p>}
            {cat.error && <p className="text-[0.8rem] text-[var(--wms-status-danger-fg)]">{String(cat.error.message)}</p>}
            {products.slice(0, 240).map((p) => (
              <button key={p.id} type="button" onClick={() => onPick({ url: p.image!, width: 1600, height: 2000, alt: p.title })} className="group flex flex-col gap-1 text-left">
                <span className="block aspect-[4/5] w-full overflow-hidden rounded border border-[var(--wms-border)] bg-[#f3f3f3] group-hover:border-[var(--wms-accent)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image!} alt="" loading="lazy" className="h-full w-full object-cover" />
                </span>
                <span className="line-clamp-2 text-[0.7rem] text-[var(--wms-muted)]">{p.title}</span>
              </button>
            ))}
          </div>
        )}
        {tab === "url" && (
          <div className="flex flex-col gap-2">
            <label className="text-[0.75rem] text-[var(--wms-muted)]" htmlFor="ce-img-url">
              Picture address (must start with https://)
            </label>
            <input id="ce-img-url" className={inputCls} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            <div>
              <button type="button" className={primaryBtn} disabled={!/^https:\/\/\S+$/.test(url.trim())} onClick={() => onPick({ url: url.trim(), width: null, height: null, alt: "" })}>
                Use this picture
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ products */

export function ProductPicker({ initial, onClose, onDone }: { initial: ProductItem[]; onClose: () => void; onDone: (items: ProductItem[]) => void }) {
  const cat = useSWR<Catalog>("/api/email/editor/catalog", fetcher);
  const [q, setQ] = useState("");
  const [who, setWho] = useState<"all" | "women" | "men" | "sets">("all");
  const [tab, setTab] = useState<"all" | "selected">("all");
  const [picked, setPicked] = useState<ProductItem[]>(initial);
  const all = useMemo(() => {
    const c = cat.data;
    if (!c) return [];
    const list = who === "sets" ? c.sets : [...c.sets, ...c.products];
    return list.filter((p) => (who === "all" || who === "sets" || p.gender === who || p.gender === "unisex") && (!q || p.title.toLowerCase().includes(q.toLowerCase())));
  }, [cat.data, who, q]);
  const shown = tab === "selected" ? picked : all;
  const isPicked = (id: string) => picked.some((x) => x.id === id);
  const toggle = (p: ProductItem) =>
    setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : cur.length >= 9 ? cur : [...cur, { id: p.id, title: p.title, price: p.price, compareAt: p.compareAt, image: p.image, url: p.url, set: p.set ?? null }]));
  return (
    <Modal
      title="Browse products"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto text-[0.78rem] text-[var(--wms-muted)]">{picked.length} of 9 chosen · only products with stock are listed</span>
          <button type="button" className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={() => onDone(picked)}>
            Add products
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--wms-muted)]" />
            <input className={`${inputCls} pl-7`} placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className={`${inputCls} w-36`} value={who} onChange={(e) => setWho(e.target.value as typeof who)} aria-label="Category">
            <option value="all">All products</option>
            <option value="women">Women</option>
            <option value="men">Men</option>
            <option value="sets">Matching sets</option>
          </select>
          <div className="inline-flex rounded border border-[var(--wms-border)] p-0.5">
            {(["all", "selected"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={`h-7 rounded px-2.5 text-[0.75rem] ${tab === t ? "bg-[var(--wms-surface-elevated)] font-semibold text-[var(--wms-fg)]" : "text-[var(--wms-muted)]"}`}>
                {t === "all" ? "All" : `Selected (${picked.length})`}
              </button>
            ))}
          </div>
        </div>
        {cat.isLoading && <p className="text-[0.8rem] text-[var(--wms-muted)]">Loading the catalog…</p>}
        {cat.error && <p className="text-[0.8rem] text-[var(--wms-status-danger-fg)]">{String(cat.error.message)}</p>}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {shown.slice(0, 300).map((p) => {
            const on = isPicked(p.id);
            return (
              <button key={p.id} type="button" onClick={() => toggle(p)} aria-pressed={on} className="relative flex flex-col gap-1 text-left">
                <span className={`block aspect-[4/5] w-full overflow-hidden rounded border-2 bg-[#f3f3f3] ${on ? "border-[var(--wms-accent)]" : "border-transparent"}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {p.image && <img src={p.image} alt="" loading="lazy" className="h-full w-full object-cover" />}
                </span>
                {on && (
                  <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]">
                    <Check size={14} />
                  </span>
                )}
                {p.set && <span className="text-[0.62rem] font-semibold uppercase tracking-wide text-[var(--wms-muted)]">{p.set.pieces}-piece set</span>}
                <span className="line-clamp-2 text-[0.75rem] text-[var(--wms-fg)]">{p.title}</span>
                <span className="text-[0.72rem] font-semibold tabular-nums text-[var(--wms-fg)]">{p.set ? `Set $${p.set.total.toFixed(2)}` : `$${p.price.toFixed(2)}`}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- layout */

export function LayoutDialog({ onClose, onPick, title = "Configure column layout" }: { onClose: () => void; onPick: (widths: number[]) => void; title?: string }) {
  const [n, setN] = useState(2);
  const [choice, setChoice] = useState(0);
  const opts = LAYOUTS[n];
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={() => onPick(opts[Math.min(choice, opts.length - 1)])}>
            Add column layout
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.75rem] text-[var(--wms-muted)]">Columns</span>
          <div className="inline-flex w-fit rounded border border-[var(--wms-border)] p-0.5">
            {[1, 2, 3, 4].map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setN(k);
                  setChoice(0);
                }}
                className={`h-8 w-10 rounded text-[0.85rem] ${n === k ? "bg-[var(--wms-surface-elevated)] font-semibold text-[var(--wms-fg)]" : "text-[var(--wms-muted)]"}`}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {opts.map((ws, i) => (
            <button key={ws.join("-")} type="button" onClick={() => setChoice(i)} className={`flex flex-col gap-1.5 rounded border-2 p-2 ${choice === i ? "border-[var(--wms-accent)]" : "border-[var(--wms-border)]"}`}>
              <span className="flex h-12 w-full gap-1">
                {ws.map((w, j) => (
                  <span key={j} className="rounded-sm bg-[var(--wms-surface-elevated)] ring-1 ring-[var(--wms-border)]" style={{ width: `${w}%` }} />
                ))}
              </span>
              <span className="text-[0.72rem] text-[var(--wms-muted)]">{n === 1 ? "Full width" : i === 0 ? "Equal" : ws.map((w) => `${Math.round(w)}%`).join(" | ")}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
