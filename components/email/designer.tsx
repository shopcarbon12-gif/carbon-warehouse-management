"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { btn, card, fetcher, field, label, send } from "@/components/marketing/marketing-shared";
import { EmailPreviewFrames } from "./preview-frame";
import { ReviewItems } from "./review-items";

/**
 * Email → AI Designer. One chat per design. Every AI turn DRAWS the email at
 * the size a customer sees it (desktop 600 px column, phone 375 px), shown
 * here at that real size. Before drawing, the AI shows the items it chose
 * (products, matching sets, CARBON pictures) for the owner to remove, swap,
 * add and approve (can be switched off). The owner picks what a message
 * changes (both / desktop / mobile), Batch (half price) or Fast, can attach
 * photos, speak, and ask for 3 different directions (continuing from the
 * picked one, or direction 1). "Convert to email" turns a version into code.
 * Versions made by the short-lived layout engine still show as real emails.
 */

type DesignRow = { id: string; title: string; status: string; updated_at: string; has_html: boolean; versions: number; working: boolean; waiting?: boolean };
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
  products: { id: string; title: string; url: string; price: number; image: string | null; set?: { name: string; line: string; total: number } | null }[];
  media: { id: string; url: string; description: string }[];
  step: string | null;
  hasMobileTop: boolean;
  needsReview: boolean | null;
  engine: "picture" | "layout";
  hasEmail: boolean;
  direction: string | null;
  variantGroup: string | null;
  variantNo: number | null;
  picked: boolean | null;
  banners: { id: string; url: string | null; qa: string | null; error: string | null; text: string | null }[];
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

const WORKING = ["queued", "planning", "generating", "approved", "approved-planning"];

const TARGETS = [
  { id: "both", label: "Both" },
  { id: "desktop", label: "Desktop only" },
  { id: "mobile", label: "Mobile only" },
] as const;

/** What an unfinished AI turn is doing right now, in words. */
function progressText(m: Msg): string {
  if (m.status === "queued") return "Waiting to start (within a minute)…";
  if (m.engine === "layout") {
    if (m.status === "planning") return m.text ? "Making the banners…" : "Designing the layout and picking the products (1 to 3 minutes)…";
    const n = m.banners.length;
    return m.mode === "fast"
      ? `Making ${n} banner${n === 1 ? "" : "s"} and checking each against the real product photos (about 2 to 6 minutes)…`
      : `Making ${n} banner${n === 1 ? "" : "s"} in the OpenAI batch (usually minutes, up to an hour), then checking them…`;
  }
  if (m.status === "planning") return m.text ? "Getting ready to draw…" : m.variantNo && m.variantNo > 1 ? "Waiting for direction 1's items, then planning this direction…" : "Choosing the items and planning the design…";
  if (m.status === "approved" || m.status === "approved-planning") return "Approved. Planning the pictures around your items…";
  const order = m.target === "both" ? ["desktop", "mobile-top", "mobile-bottom"] : m.target === "desktop" ? ["desktop"] : ["mobile-top", "mobile-bottom"];
  const at = Math.max(0, order.indexOf(m.step ?? order[0]));
  const name: Record<string, string> = { desktop: "the desktop picture", "mobile-top": "the phone picture (top part)", "mobile-bottom": "the phone picture (bottom part)" };
  const which = `${name[order[at]] ?? "the picture"}${order.length > 1 ? ` (${at + 1} of ${order.length})` : ""}`;
  return m.mode === "fast" ? `Drawing ${which}. About 1 to 3 minutes per picture…` : `Drawing ${which} in the OpenAI batch. Usually minutes, can take up to an hour…`;
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
              {d.versions} version{d.versions === 1 ? "" : "s"} · {d.waiting ? "Waiting for your approval" : d.working ? "AI working…" : d.status === "ready" ? "Email ready" : d.status === "converting" ? "Converting…" : d.status === "failed" ? "Conversion failed" : "Drafting"}
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
  if (!src) return <div className="flex h-40 items-center justify-center rounded border border-dashed border-[var(--wms-border)] text-[0.68rem] text-[var(--wms-muted)]">—</div>;
  return (
    <button type="button" onClick={() => onOpen(src)} className="block overflow-hidden rounded border border-[var(--wms-border)] bg-white" title="Open full size">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" className="block h-auto w-full" />
    </button>
  );
}

function DesignChat({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, error, mutate } = useSWR<{ design: Design; messages: Msg[] }>(`/api/email/designs/${id}`, fetcher, {
    refreshInterval: (d) => (d && (d.messages.some((m) => WORKING.includes(m.status)) || d.design.status === "converting") ? 4000 : 0),
  });
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"both" | "desktop" | "mobile">("both");
  const [mode, setMode] = useState<"batch" | "fast">("batch");
  const [review, setReview] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [editHtml, setEditHtml] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const design = data?.design;
  const messages = data?.messages ?? [];
  const working = messages.some((m) => WORKING.includes(m.status));
  const reviewing = messages.some((m) => m.status === "review");
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

  /** For 3 directions: the one the chat continues from (picked, else direction 1). */
  const isCurrent = (m: Msg) => !!m.variantGroup && (m.picked === true || (m.variantNo === 1 && !messages.some((x) => x.variantGroup === m.variantGroup && x.picked)));

  const sendMessage = (directions = false) =>
    run(directions ? "directions" : "send", async () => {
      const fd = new FormData();
      fd.set("text", text);
      fd.set("target", directions ? "both" : target);
      fd.set("mode", mode);
      fd.set("review", review ? "1" : "0");
      if (directions) fd.set("directions", "1");
      for (const f of files) fd.append("file", f);
      const r = await fetch(`/api/email/designs/${id}/messages`, { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setText("");
      setFiles([]);
      await mutate();
    });

  const pick = (messageId: string) =>
    run("pick", async () => {
      await send(`/api/email/designs/${id}/pick`, "POST", { messageId });
      await mutate();
      setMsg({ text: "The chat now continues from this direction." });
    });

  const phoneLink = (messageId: string) =>
    run("share", async () => {
      const r = await send<{ url: string }>(`/api/email/designs/${id}/share`, "POST", { messageId });
      let copied = false;
      try {
        await navigator.clipboard.writeText(r.url);
        copied = true;
      } catch {
        /* shown below */
      }
      if (!copied && typeof navigator.share === "function") await navigator.share({ url: r.url, title: "CARBON email" }).catch(() => {});
      setMsg({ text: `${copied ? "Phone link copied" : "Phone link"}: ${r.url} — paste it into WhatsApp and open it on the phone (it shows the email exactly as a phone mail app lays it out).` });
    });

  const stop = () => run("stop", async () => void (await send(`/api/email/designs/${id}/stop`, "POST"), await mutate()));
  const convert = (messageId: string) =>
    run("convert", async () => {
      await send(`/api/email/designs/${id}/convert`, "POST", { messageId });
      const layout = messages.find((x) => x.id === messageId)?.engine === "layout";
      setMsg({ text: layout ? "Packaging the email and its zip (under a minute)…" : "Converting: OpenAI is cutting out the pictures and writing the email. This takes a few minutes; you can leave the page." });
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
            Tell the AI what the email is for, who it is for and what it should say. It always uses the real CARBON logo, picks real in-stock products from the catalog, and uses CARBON&apos;s own pictures (store photos, campaign shots) and the real store address, hours and directions by itself. Example: &quot;A win-back email for past customers: $20 off one item with their own code, the new winter collection, a black and white look, a big photo of a woman in a bomber jacket, and a section asking them to follow us on Instagram.&quot; Attach product photos if you want them used.
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
                  {m.variantNo ? `Direction ${m.variantNo} of 3 · ` : ""}AI · {m.mode === "fast" ? "Fast" : "Batch"} · {TARGETS.find((t) => t.id === m.target)?.label ?? m.target}
                  {isCurrent(m) ? " · the chat continues from this one" : ""}
                </span>
                {m.status === "done" && (
                  <div className="flex flex-wrap gap-2">
                    {m.variantGroup && !isCurrent(m) && (
                      <button type="button" className={`${btn} border-[var(--wms-fg)]`} disabled={!!busy} onClick={() => pick(m.id)}>
                        Continue from this one
                      </button>
                    )}
                    {m.hasEmail && (
                      <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={!!busy} onClick={() => phoneLink(m.id)}>
                        {busy === "share" ? "Making link…" : "Copy phone link"}
                      </button>
                    )}
                    {(
                      <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy || design.status === "converting" || working} onClick={() => convert(m.id)}>
                        {design.chosen_message === m.id && design.status === "ready" ? "Use again" : m.engine === "layout" ? "Use this email" : "Convert to email"}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {m.direction && <p className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">Direction: {m.direction}</p>}
              {m.text && <p className="whitespace-pre-wrap text-sm text-[var(--wms-fg)]">{m.text}</p>}
              {m.status !== "done" && m.status !== "review" && (
                <p className={`text-xs ${m.status === "failed" ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-muted)]"}`}>
                  {m.status === "failed" ? (m.error ?? "Failed") : progressText(m)}
                </p>
              )}
              {m.status === "review" && <ReviewItems designId={id} messageId={m.id} products={m.products} media={m.media} onDone={() => void mutate()} />}
              {m.status !== "review" && m.media?.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className={label}>CARBON pictures in this version</span>
                  <div className="flex flex-wrap gap-2">
                    {m.media.map((x) => (
                      <a key={x.url} href={x.url} target="_blank" rel="noreferrer" title={x.description} className="w-40 max-md:w-32">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`${x.url}${x.url.includes("?") ? "&" : "?"}width=400`} alt={x.description} loading="lazy" className="aspect-[4/3] w-full rounded border border-[var(--wms-border)] object-cover" />
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {m.status !== "review" && m.products.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className={label}>Real products in this version</span>
                  <div className="flex flex-wrap gap-2">
                    {m.products
                      .filter((p, i, all) => !p.set || all.findIndex((x) => x.set?.name === p.set!.name) === i)
                      .map((p) => (
                        <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="flex w-28 flex-col gap-0.5 text-[0.68rem] text-[var(--wms-fg)] max-md:w-24">
                          {p.image && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={`${p.image}${p.image.includes("?") ? "&" : "?"}width=240`} alt={p.title} loading="lazy" className="aspect-[4/5] w-full rounded border border-[var(--wms-border)] object-cover" />
                          )}
                          <span className="truncate">{p.set ? p.set.name : p.title}</span>
                          <span className="text-[var(--wms-muted)]">{p.set ? `${p.set.line} · Set $${p.set.total.toFixed(2)}` : `$${p.price.toFixed(2)}`}</span>
                        </a>
                      ))}
                  </div>
                </div>
              )}
              {m.engine === "layout" && m.status === "done" && m.banners.some((b) => b.qa || b.error) && (
                <ul className="flex flex-col gap-0.5 text-[0.7rem] text-amber-700 dark:text-amber-300">
                  {m.banners
                    .filter((b) => b.qa || b.error)
                    .map((b) => (
                      <li key={b.id}>
                        Banner {b.id}: {b.error ? `not made (${b.error})` : `the check still sees: ${b.qa}`}. Ask the AI to redo it if it bothers you.
                      </li>
                    ))}
                </ul>
              )}
              {m.engine === "layout" && m.status === "done" && m.error && <p className="text-xs text-amber-700 dark:text-amber-300">{m.error}</p>}
              {m.engine === "layout" && m.status === "done" && m.hasEmail && <EmailPreviewFrames designId={id} messageId={m.id} height={900} />}
              {m.engine !== "layout" && (m.desktop || m.mobile || m.status === "done") && (
                <div className="flex items-start gap-3 overflow-x-auto pb-1">
                  <div className="flex shrink-0 flex-col gap-1" style={{ width: 600, maxWidth: "62vw" }}>
                    <span className={label}>Desktop · real size (600 px)</span>
                    <Picture src={m.desktop} alt="Desktop version" onOpen={setZoom} />
                  </div>
                  <div className="flex shrink-0 flex-col gap-1" style={{ width: 375, maxWidth: "40vw" }}>
                    <span className={label}>Phone · real size (375 px)</span>
                    <Picture src={m.mobile} alt="Phone version" onOpen={setZoom} />
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
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (text.trim() || files.length) && !working && !reviewing) sendMessage();
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
          <label className="flex items-center gap-1.5 text-xs text-[var(--wms-fg)] max-md:min-h-11">
            <input id="email-design-review" type="checkbox" className="max-md:h-5 max-md:w-5" checked={review} onChange={(e) => setReview(e.target.checked)} />
            Approve items first
          </label>
          {working || reviewing ? (
            <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy === "stop"} onClick={stop}>
              Stop the AI
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`${btn} border-[var(--wms-fg)]`}
                disabled={!!busy || reviewing || (!text.trim() && !files.length)}
                onClick={() => sendMessage(true)}
                title="Three versions in completely different directions; you pick one"
              >
                {busy === "directions" ? "Sending…" : "Show me 3 directions"}
              </button>
              <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy || reviewing || (!text.trim() && !files.length)} onClick={() => sendMessage()}>
                {busy === "send" ? "Sending…" : "Send"}
              </button>
            </>
          )}
        </div>
        <p className="text-[0.68rem] text-[var(--wms-muted)]">
          {reviewing
            ? "The AI is waiting for you to approve its items (above)."
            : "Pictures are drawn at the real email size (desktop 600 px, phone 375 px). With “Approve items first” the AI shows its products before drawing. Batch costs half (minutes to an hour); Fast takes a few minutes per picture. 3 directions makes three versions (three times the pictures); the chat continues from the one you choose, or direction 1."}
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
          {design.status === "converting" && <p className="text-xs text-[var(--wms-muted)]">Preparing the email…</p>}
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
