"use client";

import { useState } from "react";
import { btn, field, label, send } from "@/components/marketing/marketing-shared";

/**
 * AI Designer review step (owner, 2026-11-08): the creative director picked the
 * outfits; nothing is drawn until the owner approves. Each PERSON in the hero
 * and in each look gets their own row with their complete outfit ("if she
 * planned two men, one complete look of the first man, and under it the second
 * man's"). Per row: swap a piece, remove it, or add one. A matching set is one
 * item (all its pieces), like the homepage set card. Approving sends the rows
 * back, so the concept keeps the owner's exact outfits.
 */

type Product = { id: string; title: string; url: string; price: number; image: string | null; set?: { name: string; line: string; total: number } | null };
type Picture = { id: string; url: string; description: string };
type Result = { id: string; title: string; price: number; image: string | null; set: { name: string; line: string; total: number } | null; stock: number };
type Item = { key: string; ids: string[]; title: string; line: string | null; price: number; image: string | null; isSet: boolean };
type Person = { who: string; products: string[] };
export type ReviewConcept = { hero: { headline: string; people?: Person[] }; looks: { id: string; name: string; people?: Person[] }[] };
type Row = { id: string; section: string | null; person: number; title: string; who: string; items: Item[] };

const money = (n: number) => `$${n.toFixed(2)}`;
const thumb = (u: string | null, w = 240) => (u ? `${u}${u.includes("?") ? "&" : "?"}width=${w}` : null);

/** Product ids → items (the pieces of a matching set become one item). */
function itemsOf(ids: string[], products: Product[]): Item[] {
  const out: Item[] = [];
  for (const id of ids) {
    const p = products.find((x) => x.id === id);
    if (!p) continue;
    if (p.set) {
      const have = out.find((i) => i.isSet && i.title === p.set!.name);
      if (have) {
        if (!have.ids.includes(p.id)) have.ids.push(p.id);
        continue;
      }
      // A set picked by one piece brings all its pieces.
      const pieces = products.filter((x) => x.set?.name === p.set!.name).map((x) => x.id);
      out.push({ key: `set:${p.set.name}`, ids: pieces.length ? pieces : [p.id], title: p.set.name, line: p.set.line, price: p.set.total, image: p.image, isSet: true });
    } else if (!out.some((i) => i.key === p.id)) out.push({ key: p.id, ids: [p.id], title: p.title, line: null, price: p.price, image: p.image, isSet: false });
  }
  return out;
}

function rowsOf(concept: ReviewConcept | null, products: Product[]): Row[] {
  const rows: Row[] = [];
  const sections = concept ? [{ key: "h1", name: "Hero photo", people: concept.hero.people }, ...concept.looks.map((l, i) => ({ key: `l${i + 1}`, name: `Look ${i + 1} · ${l.name}`, people: l.people }))] : [];
  for (const s of sections)
    (s.people ?? []).forEach((p, i) =>
      rows.push({ id: `${s.key}-${i}`, section: s.key, person: i, title: (s.people?.length ?? 0) > 1 ? `${s.name} · person ${i + 1}` : s.name, who: p.who, items: itemsOf(p.products, products) }),
    );
  // Anything picked but not worn by anyone (or an older concept without people): its own row.
  const used = new Set(rows.flatMap((r) => r.items.flatMap((i) => i.ids)));
  const rest = itemsOf(
    products.map((p) => p.id).filter((id) => !used.has(id)),
    products,
  );
  if (rest.length) rows.push({ id: "rest", section: null, person: 0, title: rows.length ? "Other picked items" : "Items", who: "", items: rest });
  return rows;
}

const fromResult = (r: Result): Item => ({ key: r.set ? `set:${r.set.name}` : r.id, ids: [r.id], title: r.set ? r.set.name : r.title, line: r.set?.line ?? null, price: r.price, image: r.image, isSet: !!r.set });

export function ReviewItems({
  designId,
  messageId,
  products,
  media,
  concept,
  onDone,
}: {
  designId: string;
  messageId: string;
  products: Product[];
  media: Picture[];
  concept: ReviewConcept | null;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => rowsOf(concept, products));
  const [pics, setPics] = useState<Picture[]>(media);
  const [search, setSearch] = useState<{ q: string; row: string; replace: string | null } | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function find(q: string) {
    setBusy("find");
    setErr(null);
    try {
      const r = await fetch(`/api/email/catalog?q=${encodeURIComponent(q)}`);
      const j = (await r.json()) as { items?: Result[]; error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setResults(j.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Search failed");
    } finally {
      setBusy(null);
    }
  }

  function choose(res: Result) {
    if (!search) return;
    const it = fromResult(res);
    setRows((cur) =>
      cur.map((row) => {
        if (row.id !== search.row) return row;
        const without = row.items.filter((x) => x.key !== it.key);
        if (search.replace) {
          const at = without.findIndex((x) => x.key === search.replace);
          if (at >= 0) return { ...row, items: [...without.slice(0, at), it, ...without.slice(at + 1)] };
        }
        return { ...row, items: [...without, it] };
      }),
    );
    setSearch(null);
    setResults(null);
  }

  const remove = (rowId: string, key: string) => setRows((cur) => cur.map((r) => (r.id === rowId ? { ...r, items: r.items.filter((x) => x.key !== key) } : r)));

  async function approve() {
    setBusy("approve");
    setErr(null);
    try {
      const outfits = rows.filter((r) => r.section).map((r) => ({ key: r.section!, person: r.person, productIds: r.items.flatMap((i) => i.ids) }));
      await send(`/api/email/designs/${designId}/approve`, "POST", {
        messageId,
        productIds: [...new Set(rows.flatMap((r) => r.items.flatMap((i) => i.ids)))],
        mediaIds: pics.map((p) => p.id),
        ...(outfits.length ? { outfits } : {}),
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not approve");
    } finally {
      setBusy(null);
    }
  }

  const total = (r: Row) => r.items.reduce((s, i) => s + i.price, 0);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-amber-500/60 p-2">
      <div>
        <span className={label}>Approve the outfits before the AI draws</span>
        <p className="text-xs text-[var(--wms-muted)]">Each person in each photo has their own row with the complete outfit. Swap, remove or add pieces per person. A matching set counts as one item. Nothing is drawn until you approve.</p>
      </div>
      {rows.map((row) => (
        <div key={row.id} className="flex flex-col gap-1 border-t border-[var(--wms-border)] pt-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-[var(--wms-fg)]">
              {row.title}
              {row.who && <span className="font-normal text-[var(--wms-muted)]"> — {row.who}</span>}
            </span>
            {row.section && row.items.length > 0 && <span className="text-xs text-[var(--wms-muted)]">Outfit total {money(total(row))}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {row.items.map((it) => (
              <div key={it.key} className="flex w-32 flex-col gap-1 text-[0.7rem] text-[var(--wms-fg)] max-md:w-[calc(50%-0.25rem)]">
                <div className="relative">
                  {it.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb(it.image) ?? ""} alt={it.title} loading="lazy" className="aspect-[4/5] w-full rounded border border-[var(--wms-border)] object-cover" />
                  )}
                  {it.isSet && <span className="absolute left-1 top-1 bg-black px-1.5 py-0.5 text-[0.58rem] font-bold uppercase tracking-wider text-white">{Math.max(it.ids.length, 2)}-piece set</span>}
                </div>
                <span className="truncate font-semibold uppercase">{it.title}</span>
                {it.line && <span className="text-[var(--wms-muted)]">{it.line}</span>}
                <span>{it.isSet ? `Set ${money(it.price)}` : money(it.price)}</span>
                <div className="flex gap-1">
                  <button type="button" className={`${btn} flex-1 border-[var(--wms-border)] px-1`} onClick={() => (setSearch({ q: "", row: row.id, replace: it.key }), setResults(null))}>
                    Swap
                  </button>
                  <button type="button" className={`${btn} flex-1 border-[var(--wms-border)] px-1`} onClick={() => remove(row.id, it.key)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {row.section && (
              <button
                type="button"
                className="flex w-32 items-center justify-center rounded border border-dashed border-[var(--wms-border)] text-xs text-[var(--wms-muted)] hover:border-[var(--wms-fg)] max-md:min-h-24 max-md:w-[calc(50%-0.25rem)]"
                onClick={() => (setSearch({ q: "", row: row.id, replace: null }), setResults(null))}
              >
                + Add to this outfit
              </button>
            )}
          </div>
          {search?.row === row.id && (
            <div className="flex flex-col gap-2 pt-1">
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void find(search.q);
                }}
              >
                <input
                  id={`email-review-search-${row.id}`}
                  className={`${field} min-w-0 flex-1`}
                  placeholder={search.replace ? "Swap for… (e.g. black hoodie, women jeans, set)" : "Add… (e.g. puffer, men sneakers, belt)"}
                  value={search.q}
                  autoFocus
                  onChange={(e) => setSearch({ ...search, q: e.target.value })}
                />
                <button type="submit" className={`${btn} border-[var(--wms-fg)]`} disabled={busy === "find"}>
                  {busy === "find" ? "Searching…" : "Search"}
                </button>
                <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => (setSearch(null), setResults(null))}>
                  Cancel
                </button>
              </form>
              {results && (
                <div className="flex max-h-[420px] flex-wrap gap-2 overflow-y-auto">
                  {results.map((r) => (
                    <button key={r.id} type="button" onClick={() => choose(r)} className="flex w-28 flex-col gap-0.5 text-left text-[0.68rem] text-[var(--wms-fg)] hover:opacity-80 max-md:w-[calc(33%-0.4rem)]">
                      {r.image && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb(r.image) ?? ""} alt={r.title} loading="lazy" className="aspect-[4/5] w-full rounded border border-[var(--wms-border)] object-cover" />
                      )}
                      <span className="truncate font-semibold">{r.title}</span>
                      <span className="text-[var(--wms-muted)]">
                        {r.set ? `${r.set.line} · Set ${money(r.set.total)}` : money(r.price)} · {r.stock} in stock
                      </span>
                    </button>
                  ))}
                  {!results.length && <p className="text-xs text-[var(--wms-muted)]">Nothing in stock matches.</p>}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {pics.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-[var(--wms-border)] pt-2">
          <span className={label}>CARBON pictures</span>
          <div className="flex flex-wrap gap-2">
            {pics.map((p) => (
              <div key={p.id} className="flex w-40 flex-col gap-1 text-[0.7rem] max-md:w-[calc(50%-0.25rem)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumb(p.url, 400) ?? ""} alt={p.description} title={p.description} loading="lazy" className="aspect-[4/3] w-full rounded border border-[var(--wms-border)] object-cover" />
                <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setPics(pics.filter((x) => x.id !== p.id))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {err && <p className="text-xs text-[var(--wms-status-danger-fg)]">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy} onClick={approve}>
          {busy === "approve" ? "Approving…" : "Approve & draw"}
        </button>
      </div>
    </div>
  );
}
