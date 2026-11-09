"use client";

/**
 * Email Marketing → Emails: the emails built in the drag-and-drop editor (Klaviyo's "Templates").
 * New email (blank, a CARBON starter, or one of the store's saved templates), open the editor (?edit=<id> keeps it open on refresh),
 * duplicate, delete, or start a campaign with it.
 */
import { useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "next/navigation";
import { Copy, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { STARTERS } from "@/lib/email-editor/prebuilt";
import { btn, card, fetcher, send } from "@/components/marketing/marketing-shared";
import { EmailEditor } from "./editor/editor";

type Row = { id: string; title: string; subject: string | null; updated_at: string; created_by: string | null; has_es: boolean; has_pt: boolean; campaigns: number };

const html = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

/** A small picture of the email (the frame gets the HTML directly: a sandboxed frame has no session). */
function Thumb({ id, stamp, title }: { id: string; stamp: string; title: string }) {
  const { data } = useSWR(`/api/email/designs/${id}/preview?v=${encodeURIComponent(stamp)}`, html);
  if (!data) return <span className="block h-full w-full animate-pulse bg-[var(--wms-surface-elevated)]" />;
  return <iframe title={title} sandbox="" srcDoc={data} className="pointer-events-none origin-top-left" style={{ width: 680, height: 1100, transform: "scale(0.5)" }} tabIndex={-1} />;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function EmailsList({ onCampaign }: { onCampaign: (campaignId: string) => void }) {
  const editId = useSearchParams().get("edit");
  const setEdit = (v: string | null) => {
    const u = new URL(window.location.href);
    if (v) u.searchParams.set("edit", v);
    else u.searchParams.delete("edit");
    window.history.replaceState(null, "", u.toString());
  };
  const { data, error, mutate } = useSWR<{ emails: Row[] }>("/api/email/editor", fetcher);
  const [choosing, setChoosing] = useState(false);
  const lib = useSWR<{ templates: { id: string; name: string; created_at: string; created_by: string | null }[] }>(choosing ? "/api/email/editor/library" : null, fetcher);
  async function removeTemplate(t: { id: string; name: string }) {
    if (!window.confirm(`Delete the template "${t.name}"? Emails made from it stay as they are.`)) return;
    const res = await fetch(`/api/email/editor/library?id=${t.id}`, { method: "DELETE" });
    if (!res.ok) setMsg("Could not delete the template");
    await lib.mutate();
  }
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function create(body: { starter?: string; fromId?: string; templateId?: string }) {
    setMsg(null);
    setBusy(body.starter ?? body.fromId ?? body.templateId ?? "new");
    try {
      const r = await send<{ id: string }>("/api/email/editor", "POST", body);
      setChoosing(false);
      await mutate();
      setEdit(r.id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not create it");
    } finally {
      setBusy(null);
    }
  }
  async function remove(r: Row) {
    if (!window.confirm(`Delete "${r.title}"? Campaigns that already used it keep their copy.`)) return;
    const res = await fetch(`/api/email/editor/${r.id}`, { method: "DELETE" });
    if (!res.ok) setMsg("Could not delete it");
    await mutate();
  }
  async function campaign(r: Row) {
    setMsg(null);
    setBusy(`c${r.id}`);
    try {
      const c = await send<{ id: string }>("/api/email/campaigns", "POST", { name: r.title, designId: r.id, audience: { who: "all" } });
      onCampaign(c.id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not start a campaign");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {editId && (
        <EmailEditor
          id={editId}
          onClose={() => {
            setEdit(null);
            void mutate();
          }}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--wms-muted)]">Build emails with drag and drop: sections, columns, text, pictures, products, your code. What you see is what customers get.</p>
        <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} onClick={() => setChoosing(!choosing)}>
          <Plus size={13} /> New email
        </button>
      </div>
      {choosing && (
        <section className={`${card} flex flex-col gap-2`}>
          {!!lib.data?.templates.length && (
            <>
              <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Your templates</h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {lib.data.templates.map((t) => (
                  <div key={t.id} className="relative flex flex-col gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] hover:border-[var(--wms-fg)]">
                    <button type="button" disabled={!!busy} onClick={() => create({ templateId: t.id })} className="flex flex-col gap-1 p-3 pr-9 text-left disabled:opacity-50">
                      <span className="text-sm font-semibold text-[var(--wms-fg)]">{busy === t.id ? "Creating…" : t.name}</span>
                      <span className="text-xs text-[var(--wms-muted)]">Saved {when(t.created_at)}</span>
                    </button>
                    <button type="button" title="Delete template" aria-label={`Delete template ${t.name}`} onClick={() => void removeTemplate(t)} className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded text-[var(--wms-muted)] hover:text-[var(--wms-status-danger-fg)]">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          <h3 className="text-sm font-semibold text-[var(--wms-fg)]">{lib.data?.templates.length ? "CARBON starters" : "Start from"}</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {STARTERS.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={!!busy}
                onClick={() => create({ starter: s.id })}
                className="flex flex-col gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3 text-left hover:border-[var(--wms-fg)] disabled:opacity-50"
              >
                <span className="text-sm font-semibold text-[var(--wms-fg)]">{busy === s.id ? "Creating…" : s.name}</span>
                <span className="text-xs text-[var(--wms-muted)]">{s.description}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {msg && <p className="text-xs text-[var(--wms-status-danger-fg)]">{msg}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}
      {data && data.emails.length === 0 && !choosing && (
        <section className={`${card} flex flex-col items-start gap-2`}>
          <p className="text-sm text-[var(--wms-fg)]">No emails yet.</p>
          <p className="text-xs text-[var(--wms-muted)]">Press New email and start from a blank page or a CARBON starter (new collection, lookbook, personal offer, store visit).</p>
        </section>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data?.emails.map((r) => (
          <article key={r.id} className={`${card} flex flex-col gap-2`}>
            <button type="button" onClick={() => setEdit(r.id)} className="group relative block h-52 overflow-hidden rounded border border-[var(--wms-border)] bg-white text-left" aria-label={`Edit ${r.title}`}>
              <Thumb id={r.id} stamp={r.updated_at} title={r.title} />
              <span className="absolute inset-0 grid place-items-center bg-black/0 text-sm font-semibold text-transparent transition-colors group-hover:bg-black/35 group-hover:text-white">Edit</span>
            </button>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-[var(--wms-fg)]">{r.title}</h3>
              <p className="truncate text-xs text-[var(--wms-muted)]">{r.subject || "No subject line yet"}</p>
              <p className="text-[0.7rem] text-[var(--wms-muted)]">
                Edited {when(r.updated_at)}
                {r.has_es && r.has_pt ? " · ES/PT ready" : ""}
                {r.campaigns ? ` · in ${r.campaigns} campaign${r.campaigns > 1 ? "s" : ""}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} onClick={() => setEdit(r.id)}>
                <Pencil size={12} /> Edit
              </button>
              <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-border)]`} disabled={!!busy} onClick={() => campaign(r)}>
                <Send size={12} /> {busy === `c${r.id}` ? "Starting…" : "Use in a campaign"}
              </button>
              <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-border)]`} disabled={!!busy} onClick={() => create({ fromId: r.id })}>
                <Copy size={12} /> Duplicate
              </button>
              <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-border)] text-[var(--wms-status-danger-fg)]`} onClick={() => remove(r)} aria-label={`Delete ${r.title}`}>
                <Trash2 size={12} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
