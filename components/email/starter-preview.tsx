"use client";
/**
 * CarbonWMS Email — see a starter or template before choosing it (owner, 2026-11-09: "some pictures,
 * I will know what is what … some sort of preview before I choose").
 *
 * Each card shows a small picture of the email; clicking it opens the full email (computer or
 * phone) with "Start with this". Drawn in the browser with the same renderer that sends the email.
 * Empty picture spots and product grids are filled with today's in-stock catalog, the way the
 * editor fills them, so the preview looks like a real email (the pictures are examples).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Monitor, Smartphone } from "lucide-react";
import { chipTags, renderEmail } from "@/lib/email-editor/render";
import type { Block, EmailDoc, ProductItem } from "@/lib/email-editor/types";
import { Modal, ghostBtn, primaryBtn } from "./editor/pickers";

type Cat = ProductItem & { gender?: string; stock?: number };

const catFetch = (u: string) =>
  fetch(u, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { products: [] }))
    .then((j: { products?: Cat[] }) => j.products ?? [])
    .catch(() => [] as Cat[]);

export function useCatalog(on: boolean): Cat[] {
  return (
    useSWR(on ? "/api/email/editor/catalog" : null, catFetch, {
      revalidateOnFocus: false,
    }).data ?? []
  );
}

/** A copy of the email with empty pictures and product grids filled from the catalog. */
export function filledDoc(doc: EmailDoc, cat: Cat[], offset = 0): EmailDoc {
  if (!cat.length) return doc;
  const d = JSON.parse(JSON.stringify(doc)) as EmailDoc;
  const photos = cat.filter((p) => p.image);
  let next = offset;
  const photo = () => photos[next++ % Math.max(1, photos.length)];
  const fill = (b: Block) => {
    if (b.type === "image" && !b.src) {
      const p = photo();
      if (p) b.src = p.image;
    } else if (b.type === "split") {
      for (const c of b.cells)
        if (c.kind === "image" && !c.src) c.src = photo()?.image ?? null;
    } else if (
      b.type === "product" &&
      (b.source === "dynamic" || !b.items.length)
    ) {
      let list = cat;
      if (b.feed === "women" || b.feed === "men")
        list = cat.filter((p) => p.gender === b.feed || p.gender === "unisex");
      if (b.feed === "most-stock")
        list = [...cat].sort((x, y) => (y.stock ?? 0) - (x.stock ?? 0));
      const n = b.source === "static" ? b.perRow : b.perRow * b.rows;
      // Static product spots in a look get different pieces than the grids.
      const from = b.source === "static" ? (next += n) : offset;
      b.items = list
        .slice(from, from + n)
        .map((p) => ({
          id: p.id,
          title: p.title,
          price: p.price,
          compareAt: p.compareAt,
          image: p.image,
          url: p.url,
          set: p.set ?? null,
        }));
      b.startAt = 1;
    } else if (b.type === "hero") {
      b.photos = b.photos.map((x) => x ?? photo()?.image ?? null);
    } else if (b.type === "video" && !b.thumb) {
      b.thumb = photo()?.image ?? null;
    }
  };
  for (const s of d.sections)
    for (const c of s.cols) for (const b of c.blocks) fill(b);
  return d;
}

/** Personal tags shown as samples (only in the words, never inside links). */
const sampleTags = (html: string) => html.replace(/>([^<]*)</g, (_m, t: string) => `>${t.includes("{{") ? chipTags(t) : t}<`);

/** The small picture on a card: the whole email width, scaled to the card and centred in it. */
export function DocThumb({
  html,
  title,
  bg = "#FFFFFF",
  fill,
}: {
  html: string;
  title: string;
  bg?: string;
  /** Take the parent's full height (the saved-email cards) instead of the card height. */
  fill?: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0.4);
  const [boxH, setBoxH] = useState(256);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      if (el.clientWidth > 0) setScale(Math.min(0.6, el.clientWidth / FRAME_W));
      if (el.clientHeight > 0) setBoxH(el.clientHeight);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <span
      ref={box}
      className={`relative block overflow-hidden ${fill ? "h-full w-full" : "h-64 rounded border border-[var(--wms-border)]"}`}
      style={{ background: bg }}
    >
      <iframe
        title={title}
        sandbox="allow-scripts"
        srcDoc={html.replace(
          "</head>",
          "<style>html,body{overflow:hidden!important}</style></head>",
        )}
        tabIndex={-1}
        className="pointer-events-none absolute left-1/2 top-0"
        style={{
          width: FRAME_W,
          height: Math.ceil(boxH / scale) + 4,
          transform: `translateX(-50%) scale(${scale})`,
          transformOrigin: "top center",
        }}
      />
    </span>
  );
}
const FRAME_W = 640; // the 600 px email plus page around it (over 620 px, or it switches to the phone layout)

export type Choice = {
  key: string;
  name: string;
  description: string;
  doc: EmailDoc;
  onStart: () => void;
};

/** A grid of cards with pictures; click one to see the whole email before starting from it. */
export function ChoiceGrid({
  items,
  cat,
  busy,
  extra,
}: {
  items: Choice[];
  cat: Cat[];
  busy: string | null;
  extra?: (c: Choice) => React.ReactNode;
}) {
  const [open, setOpen] = useState<Choice | null>(null);
  const htmls = useMemo(
    () =>
      new Map(
        items.map((c, i) => [c.key, sampleTags(renderEmail(filledDoc(c.doc, cat, i * 3), {}, undefined, { liveHeroes: true }))]),
      ),
    [items, cat],
  );
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
        {items.map((c) => (
          <div
            key={c.key}
            className="relative flex flex-col overflow-hidden rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] hover:border-[var(--wms-fg)]"
          >
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setOpen(c)}
              className="group flex flex-col gap-2 p-2 text-left disabled:opacity-50"
              aria-label={`See ${c.name}`}
            >
              <span className="relative block">
                <DocThumb
                  html={htmls.get(c.key) ?? ""}
                  title={c.name}
                  bg={c.doc.styles.pageBg}
                />
                <span className="absolute inset-0 grid place-items-center rounded bg-black/0 text-sm font-semibold text-transparent transition-colors group-hover:bg-black/40 group-hover:text-white">
                  See it
                </span>
              </span>
              <span className="px-1 text-sm font-semibold text-[var(--wms-fg)]">
                {busy === c.key ? "Creating…" : c.name}
              </span>
              <span className="px-1 pb-1 text-xs text-[var(--wms-muted)]">
                {c.description}
              </span>
            </button>
            {extra?.(c)}
          </div>
        ))}
      </div>
      {open && (
        <ChoicePreview
          choice={open}
          html={htmls.get(open.key) ?? ""}
          busy={busy === open.key}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function ChoicePreview({
  choice,
  html,
  busy,
  onClose,
}: {
  choice: Choice;
  html: string;
  busy: boolean;
  onClose: () => void;
}) {
  const [phone, setPhone] = useState(false);
  const tab = (
    on: boolean,
    label: string,
    icon: React.ReactNode,
    click: () => void,
  ) => (
    <button
      type="button"
      onClick={click}
      aria-pressed={on}
      className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-[0.8rem] ${on ? "bg-[var(--wms-fg)] font-semibold text-[var(--wms-bg)]" : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"}`}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <Modal
      title={choice.name}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto text-[0.72rem] text-[var(--wms-muted)]">
            Pictures and products are examples from your catalog. You choose
            your own in the editor.
          </span>
          <button type="button" className={ghostBtn} onClick={onClose}>
            Back
          </button>
          <button
            type="button"
            className={primaryBtn}
            disabled={busy}
            onClick={() => {
              onClose(); // any error then shows on the page, not hidden behind this window
              choice.onStart();
            }}
          >
            {busy ? "Creating…" : "Start with this"}
          </button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 p-4">
        <p className="self-start text-[0.8rem] text-[var(--wms-muted)]">
          {choice.description}
        </p>
        <div className="flex gap-1 rounded border border-[var(--wms-border)] p-0.5">
          {tab(!phone, "Computer", <Monitor size={14} />, () =>
            setPhone(false),
          )}
          {tab(phone, "Phone", <Smartphone size={14} />, () => setPhone(true))}
        </div>
        <div className="w-full overflow-hidden rounded border border-[var(--wms-border)] bg-[#E9ECF1] p-3">
          <iframe
            title={`${choice.name} preview`}
            sandbox="allow-scripts"
            srcDoc={html}
            className="mx-auto block rounded bg-white shadow-sm"
            style={{
              width: phone ? 375 : 680,
              maxWidth: "100%",
              height: "56vh",
            }}
          />
        </div>
      </div>
    </Modal>
  );
}
