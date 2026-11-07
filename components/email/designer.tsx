"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { btn, card, fetcher, field, label, send } from "@/components/marketing/marketing-shared";
import { EmailPreviewFrames } from "./preview-frame";

/**
 * Email → AI Designer. One chat per design; every AI turn draws the whole
 * email twice (desktop + mobile). The owner picks what a message changes
 * (both / desktop / mobile), Batch (half price, slower) or Fast, can attach
 * photos and can speak instead of typing. "Convert to email" turns the chosen
 * version into a real responsive email (preview below the chat).
 */

type DesignRow = { id: string; title: string; status: string; updated_at: string; has_html: boolean; versions: number; working: boolean };
type Msg = {
  id: string;
  role: "owner" | "ai";
  text: string;
  target: "both" | "desktop" | "mobile";
  mode: "batch" | "fast" | null;
  status: string;
  error: string | null;
  created_at: string;
  attachments: { name: string; url: string | null }[];
  desktop: string | null;
  mobile: string | null;
  products: { id: string; title: string; url: string; price: number; image: string | null }[];
};
type Design = {
  id: string;
  title: string;
  status: string;
  chosen_message: string | null;
  html: string | null;
  subject_hint: string | null;
  preheader_hint: string | null;
  manifest: { notes?: string | null; merge_tags?: string[]; images?: number } | null;
  convert_error: string | null;
  package_url: string | null;
  updated_at: string;
};

const TARGETS = [
  { id: "both", label: "Both" },
  { id: "desktop", label: "Desktop only" },
  { id: "mobile", label: "Mobile only" },
] as const;

/** What an unfinished AI turn is doing right now, in words. */
function progressText(m: Msg): string {
  if (m.status === "queued") return "Waiting to start (within a minute)…";
  if (m.status === "planning" && !m.text) return "Planning the design…";
  const which = m.target === "both" ? (m.desktop ? "the phone version" : "the desktop version") : m.target === "desktop" ? "the desktop version" : "the phone version";
  const step = m.target === "both" ? (m.desktop ? " (2 of 2)" : " (1 of 2)") : "";
  return m.mode === "fast"
    ? `Drawing ${which}${step}. About 1 to 3 minutes per picture…`
    : `Drawing ${which}${step} in the OpenAI batch. Usually minutes, can take up to an hour…`;
}

function useDesignParam(): [string | null, (id: string | null) => void] {
  const id = useSearchParams().get("design");
  return [
    id,
    (v) => {
      const u = new URL(window.location.href);
      if (v) u.searchParams.set("design", v);
      else u.searchParams.delete("design");
      window.history.replaceState(null, "", u.toString());
    },
  ];
}

export function EmailDesigner() {
  const [openId, setOpenId] = useDesignParam();
  const { data, mutate } = useSWR<{ designs: DesignRow[] }>("/api/email/designs", fetcher, { refreshInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const r = await send<{ id: string }>("/api/email/designs", "POST", {});
      await mutate();
      setOpenId(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start a design");
    } finally {
      setBusy(false);
    }
  }

  if (openId) return <DesignChat id={openId} onBack={() => (setOpenId(null), void mutate())} />;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--wms-muted)]">Describe an email in your own words (or speak it). The AI draws a desktop and a mobile version; keep chatting until it is right, then convert it to a real email.</p>
        <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={busy} onClick={create}>
          {busy ? "Starting…" : "New design"}
        </button>
      </div>
      {err && <p className="text-xs text-[var(--wms-status-danger-fg)]">{err}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.designs ?? []).map((d) => (
          <button key={d.id} type="button" onClick={() => setOpenId(d.id)} className={`${card} text-left hover:border-[var(--wms-fg)]`}>
            <span className="block truncate text-sm font-semibold text-[var(--wms-fg)]">{d.title}</span>
            <span className="block text-xs text-[var(--wms-muted)]">
              {d.versions} version{d.versions === 1 ? "" : "s"} · {d.working ? "AI working…" : d.status === "ready" ? "Email ready" : d.status === "converting" ? "Converting…" : d.status === "failed" ? "Conversion failed" : "Drafting"}
            </span>
            <span className="block text-[0.68rem] text-[var(--wms-muted)]">{new Date(d.updated_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}</span>
          </button>
        ))}
        {data && !data.designs.length && <p className="text-xs text-[var(--wms-muted)]">No designs yet.</p>}
      </div>
    </div>
  );
}

function Picture({ src, alt, onOpen }: { src: string | null; alt: string; onOpen: (s: string) => void }) {
  if (!src) return <div className="flex aspect-[1/2] items-center justify-center rounded border border-dashed border-[var(--wms-border)] text-[0.68rem] text-[var(--wms-muted)]">—</div>;
  return (
    <button type="button" onClick={() => onOpen(src)} className="block overflow-hidden rounded border border-[var(--wms-border)] bg-white" title="Open full size">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" className="block h-auto w-full" />
    </button>
  );
}

function DesignChat({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, error, mutate } = useSWR<{ design: Design; messages: Msg[] }>(`/api/email/designs/${id}`, fetcher, {
    refreshInterval: (d) => (d && (d.messages.some((m) => ["queued", "planning", "generating"].includes(m.status)) || d.design.status === "converting") ? 4000 : 0),
  });
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"both" | "desktop" | "mobile">("both");
  const [mode, setMode] = useState<"batch" | "fast">("batch");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [editHtml, setEditHtml] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const design = data?.design;
  const messages = data?.messages ?? [];
  const working = messages.some((m) => ["queued", "planning", "generating"].includes(m.status));
  const hasViews = messages.some((m) => m.role === "ai" && m.status === "done");

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(null);
    }
  }

  const sendMessage = () =>
    run("send", async () => {
      const fd = new FormData();
      fd.set("text", text);
      fd.set("target", target);
      fd.set("mode", mode);
      for (const f of files) fd.append("file", f);
      const r = await fetch(`/api/email/designs/${id}/messages`, { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setText("");
      setFiles([]);
      await mutate();
    });

  const stop = () => run("stop", async () => void (await send(`/api/email/designs/${id}/stop`, "POST"), await mutate()));
  const convert = (messageId: string) =>
    run("convert", async () => {
      await send(`/api/email/designs/${id}/convert`, "POST", { messageId });
      setMsg({ text: "Converting: OpenAI is cutting out the pictures and writing the email. This takes a few minutes; you can leave the page." });
      await mutate();
    });

  async function toggleMic() {
    if (rec) {
      rec.stop();
      return;
    }
    setMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRec(null);
        const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
        if (!blob.size) return;
        await run("voice", async () => {
          const fd = new FormData();
          fd.set("audio", blob, "voice");
          const res = await fetch("/api/email/transcribe", { method: "POST", body: fd });
          const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          setText((t) => (t ? `${t} ${j.text ?? ""}` : (j.text ?? "")).trim());
        });
      };
      r.start();
      setRec(r);
      setTimeout(() => r.state === "recording" && r.stop(), 180_000);
    } catch {
      setMsg({
        text: "This app can't use the microphone yet. Tap the text box and use the microphone key on your phone's keyboard instead (it types what you say). On a computer, allow microphone access for this site.",
        err: true,
      });
    }
  }

  const saveHtml = () =>
    run("html", async () => {
      await send(`/api/email/designs/${id}`, "PATCH", { html: editHtml ?? "" });
      setEditHtml(null);
      await mutate();
      setMsg({ text: "Email code saved." });
    });

  const uploadZip = (f: File) =>
    run("zip", async () => {
      const fd = new FormData();
      fd.set("file", f);
      const r = await fetch(`/api/email/designs/${id}/package`, { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string; images?: number };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await mutate();
      setMsg({ text: `Package loaded (${j.images ?? 0} pictures).` });
    });

  const rename = (title: string) => run("title", async () => void (await send(`/api/email/designs/${id}`, "PATCH", { title }), await mutate()));

  if (error) return <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>;
  if (!design) return <p className="text-xs text-[var(--wms-muted)]">Loading…</p>;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={onBack}>
          ← All designs
        </button>
        <input
          id="email-design-title"
          key={design.title}
          className={`${field} min-w-0 flex-1 font-sans text-sm font-semibold`}
          defaultValue={design.title}
          onBlur={(e) => e.target.value.trim() && e.target.value !== design.title && rename(e.target.value.trim())}
        />
        <span className="font-mono text-[0.68rem] uppercase text-[var(--wms-muted)]">{design.status === "ready" ? "Email ready" : design.status}</span>
      </div>
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}

      <div className="flex min-w-0 flex-col gap-3">
        {messages.length === 0 && (
          <div className={`${card} text-xs text-[var(--wms-muted)]`}>
            Tell the AI what the email is for, who it is for and what it should say. It always uses the real CARBON logo and picks real in-stock products from the catalog by itself. Example: &quot;A win-back email for past customers: $20 off one item with their own code, the new winter collection, a black and white look, a big photo of a woman in a bomber jacket, and a section asking them to follow us on Instagram.&quot; Attach product photos if you want them used.
          </div>
        )}
        {messages.map((m) =>
          m.role === "owner" ? (
            <div key={m.id} className="ml-auto flex max-w-[85%] flex-col items-end gap-1 max-md:max-w-[95%]">
              <div className="whitespace-pre-wrap rounded-md bg-[var(--wms-fg)] px-3 py-2 text-sm text-[var(--wms-bg)]">{m.text}</div>
              <span className="font-mono text-[0.62rem] uppercase text-[var(--wms-muted)]">Changes: {TARGETS.find((t) => t.id === m.target)?.label ?? m.target}</span>
              {m.attachments.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1">
                  {m.attachments.map((a) =>
                    a.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={a.url} src={a.url} alt={a.name} className="h-16 w-16 rounded border border-[var(--wms-border)] object-cover" />
                    ) : null,
                  )}
                </div>
              )}
            </div>
          ) : (
            <div key={m.id} className={`${card} flex max-w-full flex-col gap-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={label}>
                  AI · {m.mode === "fast" ? "Fast" : "Batch"} · {TARGETS.find((t) => t.id === m.target)?.label ?? m.target}
                </span>
                {m.status === "done" && (
                  <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy || design.status === "converting" || working} onClick={() => convert(m.id)}>
                    {design.chosen_message === m.id && design.status === "ready" ? "Convert again" : "Convert to email"}
                  </button>
                )}
              </div>
              {m.text && <p className="whitespace-pre-wrap text-sm text-[var(--wms-fg)]">{m.text}</p>}
              {m.status !== "done" && (
                <p className={`text-xs ${m.status === "failed" ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-muted)]"}`}>
                  {m.status === "failed" ? (m.error ?? "Failed") : progressText(m)}
                </p>
              )}
              {m.products.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className={label}>Real products in this version</span>
                  <div className="flex flex-wrap gap-2">
                    {m.products.map((p) => (
                      <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="flex w-28 flex-col gap-0.5 text-[0.68rem] text-[var(--wms-fg)] max-md:w-24">
                        {p.image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`${p.image}${p.image.includes("?") ? "&" : "?"}width=240`} alt={p.title} loading="lazy" className="aspect-[4/5] w-full rounded border border-[var(--wms-border)] object-cover" />
                        )}
                        <span className="truncate">{p.title}</span>
                        <span className="text-[var(--wms-muted)]">${p.price}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {(m.desktop || m.mobile || m.status === "done") && (
                <div className="grid grid-cols-[5fr_3fr] items-start gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={label}>Desktop</span>
                    <Picture src={m.desktop} alt="Desktop version" onOpen={setZoom} />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={label}>Mobile</span>
                    <Picture src={m.mobile} alt="Mobile version" onOpen={setZoom} />
                  </div>
                </div>
              )}
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      <div className={`${card} flex flex-col gap-2`}>
        <textarea
          id="email-design-prompt"
          className={`${field} min-h-[96px] font-sans text-sm`}
          placeholder={hasViews ? "What should change? (e.g. make the photo bigger, change the button to “Shop the drop”)" : "Describe the email you want…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (text.trim() || files.length) && !working) sendMessage();
          }}
        />
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1 text-[0.68rem] text-[var(--wms-muted)]">
            {files.map((f, i) => (
              <button key={f.name + i} type="button" className="rounded border border-[var(--wms-border)] px-1.5 py-0.5 max-md:py-2" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                {f.name} ✕
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-[var(--wms-border)]" role="group" aria-label="Which view to change">
            {TARGETS.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={!hasViews && t.id !== "both"}
                onClick={() => setTarget(t.id)}
                className={`px-2.5 py-1 font-mono text-[0.68rem] uppercase disabled:opacity-40 max-md:min-h-11 ${target === t.id || (!hasViews && t.id === "both") ? "bg-[var(--wms-fg)] text-[var(--wms-bg)]" : "text-[var(--wms-fg)]"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-md border border-[var(--wms-border)]" role="group" aria-label="Speed">
            {(
              [
                ["batch", "Batch · half price"],
                ["fast", "Fast"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setMode(k)} className={`px-2.5 py-1 font-mono text-[0.68rem] uppercase max-md:min-h-11 ${mode === k ? "bg-[var(--wms-fg)] text-[var(--wms-bg)]" : "text-[var(--wms-fg)]"}`}>
                {l}
              </button>
            ))}
          </div>
          <label className={`${btn} cursor-pointer border-[var(--wms-border)] max-md:flex max-md:items-center`}>
            Photos
            <input
              id="email-design-files"
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 6));
                e.target.value = "";
              }}
            />
          </label>
          <button type="button" className={`${btn} ${rec ? "border-red-500 text-red-600" : "border-[var(--wms-border)]"}`} disabled={busy === "voice"} onClick={toggleMic} aria-pressed={!!rec}>
            {rec ? "■ Stop recording" : busy === "voice" ? "Listening…" : "🎤 Speak"}
          </button>
          <span className="flex-1" />
          {working ? (
            <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy === "stop"} onClick={stop}>
              Stop the AI
            </button>
          ) : (
            <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy || (!text.trim() && !files.length)} onClick={sendMessage}>
              {busy === "send" ? "Sending…" : "Send"}
            </button>
          )}
        </div>
        <p className="text-[0.68rem] text-[var(--wms-muted)]">
          Batch costs half and usually comes back within minutes to an hour; Fast comes back in about a minute or two. The first version always draws both views.
        </p>
      </div>

      {(design.status === "converting" || design.status === "failed" || design.html) && (
        <section className={`${card} flex flex-col gap-2`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={label}>The email</span>
            <div className="flex flex-wrap gap-2">
              {design.package_url && (
                <a className={`${btn} border-[var(--wms-border)] max-md:flex max-md:items-center`} href={design.package_url}>
                  Download zip
                </a>
              )}
              <label className={`${btn} cursor-pointer border-[var(--wms-border)] max-md:flex max-md:items-center`}>
                Upload zip
                <input id="email-design-zip" type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => (e.target.files?.[0] && uploadZip(e.target.files[0]), (e.target.value = ""))} />
              </label>
              {design.html && (
                <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setEditHtml(editHtml === null ? design.html : null)}>
                  {editHtml === null ? "Edit code" : "Close code"}
                </button>
              )}
            </div>
          </div>
          {design.status === "converting" && <p className="text-xs text-[var(--wms-muted)]">Converting: OpenAI is cutting out the pictures and writing the email…</p>}
          {design.status === "failed" && design.convert_error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{design.convert_error}</p>}
          {design.html && (
            <>
              <p className="text-xs text-[var(--wms-muted)]">
                Subject idea: <b className="text-[var(--wms-fg)]">{design.subject_hint ?? "—"}</b> · Preview text: {design.preheader_hint ?? "—"}
                {design.manifest?.merge_tags?.length ? ` · Personal parts: ${design.manifest.merge_tags.join(", ")}` : ""}
              </p>
              {design.manifest?.notes && <p className="text-xs text-amber-700 dark:text-amber-300">{design.manifest.notes}</p>}
              {editHtml !== null ? (
                <div className="flex flex-col gap-2">
                  <textarea id="email-design-html" className={`${field} min-h-[320px] text-[0.72rem]`} value={editHtml} onChange={(e) => setEditHtml(e.target.value)} spellCheck={false} />
                  <div>
                    <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={busy === "html"} onClick={saveHtml}>
                      {busy === "html" ? "Saving…" : "Save code"}
                    </button>
                  </div>
                </div>
              ) : (
                <EmailPreviewFrames designId={id} version={design.updated_at} />
              )}
            </>
          )}
        </section>
      )}

      {zoom && (
        <div className="fixed inset-0 z-[300] flex items-start justify-center overflow-auto bg-black/80 p-4 max-md:p-0" onClick={() => setZoom(null)} role="dialog" aria-label="Full-size picture">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="Full-size design" className="h-auto max-w-[min(100%,900px)]" />
        </div>
      )}
    </div>
  );
}
