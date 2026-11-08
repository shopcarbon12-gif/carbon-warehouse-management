"use client";

import { useState } from "react";
import { btn, field, label, send } from "@/components/marketing/marketing-shared";

/**
 * AI Designer review step (owner, 2026-11-08): the AI has chosen products,
 * matching sets and CARBON pictures and is waiting. The owner removes, swaps
 * or adds items, then approves; only then the pictures are drawn.
 * A matching set is one item (all its pieces), like the homepage set card.
 */

type Product = { id: string; title: string; url: string; price: number; image: string | null; set?: { name: string; line: string; total: number } | null };
type Picture = { id: string; url: string; description: string };
type Result = { id: string; title: string; price: number; image: string | null; set: { name: string; line: string; total: number } | null; stock: number };
type Item = { key: string; ids: string[]; title: string; line: string | null; price: number; image: string | null; url: string | null; isSet: boolean };

const money = (n: number) => `$${n.toFixed(2)}`;
const thumb = (u: string | null, w = 240) => (u ? `${u}${u.includes("?") ? "&" : "?"}width=${w}` : null);

function itemsFrom(products: Product[]): Item[] {
  const out: Item[] = [];
  for (const p of products) {
    if (p.set) {
      const have = out.find((i) => i.isSet && i.title === p.set!.name);
      if (have) {
        have.ids.push(p.id);
        continue;
      }
      out.push({ key: `set:${p.set.name}`, ids: [p.id], title: p.set.name, line: p.set.line, price: p.set.total, image: p.image, url: p.url, isSet: true });
    } else out.push({ key: p.id, ids: [p.id], title: p.title, line: null, price: p.price, image: p.image, url: p.url, isSet: false });
  }
  return out;
}

const fromResult = (r: Result): Item => ({
  key: r.set ? `set:${r.set.name}` : r.id,
  ids: [r.id],
  title: r.set ? r.set.name : r.title,
  line: r.set?.line ?? null,
  price: r.price,
  image: r.image,
  url: null,
  isSet: !!r.set,
});

export function ReviewItems({ designId, messageId, products, media, onDone }: { designId: string; messageId: string; products: Product[]; media: Picture[]; onDone: () => void }) {
  const [items, setItems] = useState<Item[]>(() => itemsFrom(products));
  const [pics, setPics] = useState<Picture[]>(media);
  const [search, setSearch] = useState<{ q: string; forKey: string | null } | null>(null);
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

  function choose(r: Result) {
    const it = fromResult(r);
    setItems((cur) => {
      const without = cur.filter((x) => x.key !== it.key);
      if (search?.forKey) {
        const at = without.findIndex((x) => x.key === search.forKey);
        if (at >= 0) return [...without.slice(0, at), it, ...without.slice(at + 1)];
      }
      return [...without, it];
    });
    setSearch(null);
    setResults(null);
  }

  async function approve() {
    setBusy("approve");
    setErr(null);
    try {
      await send(`/api/email/designs/${designId}/approve`, "POST", { messageId, productIds: items.flatMap((i) => i.ids), mediaIds: pics.map((p) => p.id) });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not approve");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/60 p-2">
      <span className={label}>Approve the items before the AI draws</span>
      <p className="text-xs text-[var(--wms-muted)]">Remove anything you don&apos;t want, swap an item for another, or add more. A matching set counts as one item. Nothing is drawn until you approve.</p>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => (
          <div key={it.key} className="flex w-36 flex-col gap-1 text-[0.7rem] text-[var(--wms-fg)] max-md:w-[calc(50%-0.25rem)]">
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
              <button type="button" className={`${btn} flex-1 border-[var(--wms-border)] px-1`} onClick={() => (setSearch({ q: it.isSet ? "set" : "", forKey: it.key }), setResults(null))}>
                Swap
              </button>
              <button type="button" className={`${btn} flex-1 border-[var(--wms-border)] px-1`} onClick={() => setItems(items.filter((x) => x.key !== it.key))}>
                Remove
              </button>
            </div>
          </div>
        ))}
        {!items.length && <p className="text-xs text-[var(--wms-muted)]">No products (the email will show none).</p>}
      </div>
      {pics.length > 0 && (
        <div className="flex flex-col gap-1">
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
      {search ? (
        <div className="flex flex-col gap-2">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void find(search.q);
            }}
          >
            <input
              id="email-review-search"
              className={`${field} min-w-0 flex-1`}
              placeholder={search.forKey ? "Swap for… (e.g. black hoodie, women jeans, set)" : "Add… (e.g. puffer, men sneakers, set)"}
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
                  <span className="text-[var(--wms-muted)]">{r.set ? `${r.set.line} · Set ${money(r.set.total)}` : money(r.price)} · {r.stock} in stock</span>
                </button>
              ))}
              {!results.length && <p className="text-xs text-[var(--wms-muted)]">Nothing in stock matches.</p>}
            </div>
          )}
        </div>
      ) : (
        <div>
          <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => (setSearch({ q: "", forKey: null }), setResults(null))}>
            + Add a product or set
          </button>
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
