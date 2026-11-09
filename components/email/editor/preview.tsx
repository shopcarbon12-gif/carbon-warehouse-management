"use client";

/**
 * Email editor — Preview (Klaviyo's full-screen preview: Desktop / Mobile, the links in the email,
 * the total size against Gmail's 102 KB clipping limit, "Send a test"), plus the Spanish/Portuguese
 * copies, and the version history panel.
 */
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Monitor, Smartphone, X } from "lucide-react";
import { renderEmail } from "@/lib/email-editor/render";
import type { EmailDoc } from "@/lib/email-editor/types";
import { inputCls } from "./fields";
import { ghostBtn, primaryBtn } from "./pickers";

const text = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

export function PreviewSheet({
  id,
  doc,
  stamp,
  lang,
  setLang,
  translate,
  onClose,
}: {
  id: string;
  doc: EmailDoc;
  stamp: string;
  lang: { status: string | null; es: boolean; pt: boolean };
  setLang: () => void;
  translate: () => Promise<void>;
  onClose: () => void;
}) {
  const [view, setView] = useState<"desktop" | "mobile">("desktop");
  const [l, setL] = useState<"en" | "es" | "pt">("en");
  const { data, error } = useSWR(`/api/email/designs/${id}/preview?v=${encodeURIComponent(stamp)}${l !== "en" ? `&lang=${l}` : ""}`, text);
  const html = useMemo(() => renderEmail(doc), [doc]);
  const links = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of html.matchAll(/<a\b[^>]*href="([^"]*)"/gi)) {
      const u = m[1].replace(/&amp;/g, "&");
      out.set(u, (out.get(u) ?? 0) + 1);
    }
    return [...out.entries()];
  }, [html]);
  const kb = Math.round(((data ?? html).length / 1024) * 10) / 10;
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function sendTest() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/email/editor/${id}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test", to }) });
      const j = (await r.json()) as { to?: string[]; error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setMsg({ ok: true, text: `Sent to ${j.to?.join(", ")}. It uses a sample code (CB20-TEST00).` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-[var(--wms-bg)]" role="dialog" aria-modal="true" aria-label="Preview">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--wms-border)] bg-[var(--wms-surface)] px-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[0.9rem] font-semibold text-[var(--wms-fg)]">Preview</h2>
          <div className="inline-flex rounded border border-[var(--wms-border)] p-0.5">
            {(
              [
                ["desktop", <Monitor key="d" size={14} />, "Desktop"],
                ["mobile", <Smartphone key="m" size={14} />, "Mobile"],
              ] as const
            ).map(([v, icon, label]) => (
              <button key={v} type="button" onClick={() => setView(v)} className={`inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-[0.78rem] ${view === v ? "bg-[var(--wms-surface-elevated)] font-semibold text-[var(--wms-fg)]" : "text-[var(--wms-muted)]"}`}>
                {icon}
                {label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded border border-[var(--wms-border)] p-0.5">
            {(["en", "es", "pt"] as const).map((x) => (
              <button
                key={x}
                type="button"
                disabled={(x === "es" && !lang.es) || (x === "pt" && !lang.pt)}
                onClick={() => setL(x)}
                className={`h-7 rounded px-2.5 text-[0.78rem] uppercase disabled:opacity-40 ${l === x ? "bg-[var(--wms-surface-elevated)] font-semibold text-[var(--wms-fg)]" : "text-[var(--wms-muted)]"}`}
              >
                {x}
              </button>
            ))}
          </div>
        </div>
        <button type="button" onClick={onClose} className={ghostBtn}>
          <span className="inline-flex items-center gap-1">
            <X size={14} /> Close preview
          </span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto bg-[#E9ECF1] p-6">
          {error && <p className="text-[0.8rem] text-[var(--wms-status-danger-fg)]">{error.message}</p>}
          {data === undefined && !error && <p className="text-[0.8rem] text-[#5b6170]">Loading…</p>}
          {data !== undefined && (
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={data}
              className={`mx-auto block rounded-md border border-[#d5d9e0] bg-white shadow-sm ${view === "mobile" ? "rounded-[28px] border-[10px] border-[#1d1f24]" : ""}`}
              style={{ width: view === "mobile" ? 395 : 680, height: "calc(100vh - 140px)" }}
            />
          )}
        </div>
        <aside className="flex w-[340px] shrink-0 flex-col gap-0 overflow-y-auto border-l border-[var(--wms-border)] bg-[var(--wms-surface)]">
          <section className="flex flex-col gap-2 border-b border-[var(--wms-border)] p-4">
            <h3 className="text-[0.8rem] font-semibold text-[var(--wms-fg)]">Send a test</h3>
            <input className={inputCls} placeholder="you@shopcarbon.com, another@…" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Test addresses" />
            <p className="text-[0.7rem] text-[var(--wms-muted)]">Up to 5 addresses, separated by commas. Leave empty to send it to yourself.</p>
            <div>
              <button type="button" className={primaryBtn} disabled={busy} onClick={sendTest}>
                {busy ? "Sending…" : "Send test"}
              </button>
            </div>
            {msg && <p className={`text-[0.75rem] ${msg.ok ? "text-[var(--wms-status-success-fg)]" : "text-[var(--wms-status-danger-fg)]"}`}>{msg.text}</p>}
          </section>
          <section className="flex flex-col gap-2 border-b border-[var(--wms-border)] p-4">
            <h3 className="text-[0.8rem] font-semibold text-[var(--wms-fg)]">Total size</h3>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]">
              <div className={`h-full ${kb > 100 ? "bg-[var(--wms-status-danger-fg)]" : kb > 80 ? "bg-[var(--wms-status-warning-fg)]" : "bg-[var(--wms-status-success-fg)]"}`} style={{ width: `${Math.min(100, (kb / 102) * 100)}%` }} />
            </div>
            <p className="text-[0.75rem] text-[var(--wms-muted)]">
              About {kb} KB. {kb > 102 ? "Gmail will cut this email off (over 102 KB): remove some blocks." : "Not at risk of being cut off in Gmail."}
            </p>
          </section>
          <section className="flex flex-col gap-2 border-b border-[var(--wms-border)] p-4">
            <h3 className="text-[0.8rem] font-semibold text-[var(--wms-fg)]">Spanish and Portuguese</h3>
            <p className="text-[0.75rem] text-[var(--wms-muted)]">
              {lang.status === "running"
                ? "Translating now…"
                : lang.es && lang.pt
                  ? "Both copies are ready. Customers see a language bar at the top."
                  : "No copies yet, or the email changed since the last translation."}
            </p>
            <div>
              <button
                type="button"
                className={ghostBtn}
                disabled={lang.status === "running"}
                onClick={async () => {
                  await translate();
                  setLang();
                }}
              >
                {lang.es && lang.pt ? "Translate again" : "Translate"}
              </button>
            </div>
          </section>
          <section className="flex flex-col gap-2 p-4">
            <h3 className="text-[0.8rem] font-semibold text-[var(--wms-fg)]">Links ({links.length})</h3>
            <ul className="flex flex-col gap-1">
              {links.map(([u, n]) => (
                <li key={u} className="flex items-start gap-2 text-[0.72rem]">
                  <span className={`min-w-0 flex-1 break-all ${u === "#" || !u ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-fg)]"}`}>{u === "#" || !u ? "(no link set)" : u}</span>
                  {n > 1 && <span className="shrink-0 text-[var(--wms-muted)]">×{n}</span>}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

type Version = { id: string; at: string; by: string | null; doc: EmailDoc };

export function VersionsPanel({ id, onRestore, onClose }: { id: string; onRestore: (d: EmailDoc) => void; onClose: () => void }) {
  const { data, error, isLoading } = useSWR<{ versions: Version[] }>(`/api/email/editor/${id}/versions`, async (u: string) => {
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  return (
    <aside className="flex w-[310px] shrink-0 flex-col border-l border-[var(--wms-border)] bg-[var(--wms-surface)]">
      <header className="flex h-11 items-center justify-between border-b border-[var(--wms-border)] px-4">
        <h3 className="text-[0.85rem] font-semibold text-[var(--wms-fg)]">Version history</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 place-items-center rounded text-[var(--wms-muted)] hover:text-[var(--wms-fg)]">
          <X size={15} />
        </button>
      </header>
      <p className="px-4 py-3 text-[0.72rem] leading-relaxed text-[var(--wms-muted)]">A version is saved each time you leave the editor, and every 10 minutes while you work. Restoring can be undone.</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {isLoading && <p className="px-2 text-[0.75rem] text-[var(--wms-muted)]">Loading…</p>}
        {error && <p className="px-2 text-[0.75rem] text-[var(--wms-status-danger-fg)]">{error.message}</p>}
        {data?.versions.length === 0 && <p className="px-2 text-[0.75rem] text-[var(--wms-muted)]">No versions yet.</p>}
        {data?.versions.map((v, i) => (
          <div key={v.id} className="flex items-center justify-between gap-2 rounded px-2 py-2 hover:bg-[var(--wms-surface-elevated)]">
            <div className="min-w-0">
              <div className="text-[0.78rem] font-semibold text-[var(--wms-fg)]">
                {new Date(v.at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                {i === 0 && <span className="ml-1.5 text-[0.68rem] font-normal text-[var(--wms-muted)]">latest</span>}
              </div>
              <div className="truncate text-[0.7rem] text-[var(--wms-muted)]">{v.by ?? "—"} · {v.doc.sections.length} sections</div>
            </div>
            <button type="button" className="shrink-0 text-[0.75rem] font-semibold text-[var(--wms-accent)] hover:underline" onClick={() => onRestore(v.doc)}>
              Restore
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
