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
  concept: Concept | null;
  shots: { id: string; kind: "hero" | "look"; url: string | null; qa: string | null; error: string | null }[];
  creativeModel: string | null;
  imageModel: string | null;
};
type Design = {
  id: string;
  title: string;
  status: string;
  chosen_message: string | null;
  html: string | null;
  subject_hint: string | null;
  preheader_hint: string | null;
  manifest: { notes?: string | null; merge_tags?: string[]; image_count?: number } | null;
  convert_error: string | null;
  check_status: "running" | "queued" | "passed" | "failed" | "error" | null;
  check_override: boolean;
  html_es: string | null;
  html_pt: string | null;
  translate_status: "running" | "done" | "failed" | null;
  check_rounds: { round: number; pass: boolean; score: number; summary: string; issues: { severity: string; view: string; where: string; problem: string; fix: string }[]; desktop: string | null; phone: string | null; model: string; fixed?: boolean; error?: string }[];
  package_url: string | null;
  updated_at: string;
};

type Concept = {
  story: string;
  hero: { scene: string; headline: string; people?: { who: string; products: string[] }[] };
  looks: { id: string; name: string; mood: string; copy: string; people?: { who: string; products: string[] }[] }[];
  offer: { headline: string; text: string };
  showroom: { headline: string; text: string };
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
  if (m.step === "concept" && m.status === "planning") return "The creative director is writing the concept (the idea, the hero, three looks)…";
  if (m.step === "all")
    return m.mode === "fast"
      ? "Drawing everything at once: the 4 campaign photos and the desktop + phone pictures of every direction (about 3 to 6 minutes), then pasting in the real photos and logo…"
      : "Everything is in one OpenAI batch: the 4 campaign photos and the desktop + phone pictures of every direction (usually minutes, up to an hour). Then the real photos and logo are pasted in…";
  if (m.step === "shots")
    return m.mode === "fast"
      ? "Making the 4 campaign photos (hero + 3 looks) and checking each against the real products (about 2 to 4 minutes)…"
      : "Making the 4 campaign photos in the OpenAI batch (usually minutes, up to an hour), then checking each…";
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

/** The converted email in English, Spanish or Portuguese (as customers see it, with the language bar). */
function LanguagePreview({ design, designId }: { design: Design; designId: string }) {
  const [lang, setLang] = useState<"en" | "es" | "pt">("en");
  const has = { en: true, es: !!design.html_es, pt: !!design.html_pt };
  const status =
    design.translate_status === "running"
      ? "Translating into Spanish and Portuguese…"
      : design.translate_status === "failed"
        ? "A translation could not be made safely (links or personal fields did not match). Press Check again to retry."
        : !design.html_es && !design.html_pt
          ? "Spanish and Portuguese are made after the visual check."
          : "Every customer gets a bold bar on top of the email to read it in Spanish or Portuguese.";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-[var(--wms-border)]" role="group" aria-label="Language">
          {(
            [
              ["en", "English"],
              ["es", "Español"],
              ["pt", "Português"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              disabled={!has[k]}
              onClick={() => setLang(k)}
              className={`px-2.5 py-1 font-mono text-[0.68rem] uppercase disabled:opacity-40 max-md:min-h-11 ${lang === k ? "bg-[var(--wms-fg)] text-[var(--wms-bg)]" : "text-[var(--wms-fg)]"}`}
            >
              {l}
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--wms-muted)]">{status}</span>
      </div>
      <EmailPreviewFrames designId={designId} version={design.updated_at} lang={has[lang] ? lang : "en"} />
    </div>
  );
}

/** Steps 5–6: the rendered email's visual check (screenshots, problems, fixes). */
function CheckPanel({ design, busy, onAction, onZoom }: { design: Design; busy: string | null; onAction: (a: "check" | "override") => void; onZoom: (s: string) => void }) {
  const running = design.status === "checking" || design.check_status === "running" || design.check_status === "queued";
  const rounds = design.check_rounds ?? [];
  const last = rounds.at(-1);
  const tone =
    design.check_status === "passed" ? "border-emerald-500/60" : design.check_status === "failed" || design.check_status === "error" ? "border-amber-500/70" : "border-[var(--wms-border)]";
  return (
    <div className={`flex flex-col gap-2 rounded-md border p-2 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={label}>
          Visual check
          {running
            ? " · running (rendering the email, the creative director reviews the screenshots)…"
            : design.check_status === "passed"
              ? ` · passed${last ? ` (score ${last.score}/10)` : ""}`
              : design.check_status === "failed"
                ? ` · not passed${last ? ` (score ${last.score}/10)` : ""}${design.check_override ? " · you chose to use it anyway" : ""}`
                : design.check_status === "error"
                  ? " · could not run"
                  : " · not run yet"}
        </span>
        {!running && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={!!busy} onClick={() => onAction("check")}>
              {busy === "check-check" ? "Starting…" : "Check again"}
            </button>
            {(design.check_status === "failed" || design.check_status === "error") && !design.check_override && (
              <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={!!busy} onClick={() => onAction("override")}>
                Use anyway
              </button>
            )}
          </div>
        )}
      </div>
      {rounds.map((r) => (
        <div key={r.round} className="flex flex-col gap-1 border-t border-[var(--wms-border)] pt-1 text-xs text-[var(--wms-fg)]">
          <span className="font-semibold">
            Round {r.round}: {r.error ? "could not run" : r.pass ? "passed" : "not passed"} {r.error ? "" : `· ${r.score}/10`}
            {r.model ? ` · ${r.model}` : ""}
            {r.fixed ? " · fixed automatically, checked again" : ""}
          </span>
          {r.error ? <span className="text-[var(--wms-status-danger-fg)]">{r.error}</span> : r.summary && <span>{r.summary}</span>}
          {r.issues.length > 0 && (
            <ul className="list-disc pl-4">
              {r.issues.map((i, n) => (
                <li key={n} className={i.severity === "high" ? "text-[var(--wms-status-danger-fg)]" : ""}>
                  [{i.severity}, {i.view}] {i.where}: {i.problem}
                </li>
              ))}
            </ul>
          )}
          {(r.desktop || r.phone) && (
            <div className="flex gap-2">
              {[r.desktop, r.phone].map((u, k) =>
                u ? (
                  <button key={k} type="button" onClick={() => onZoom(u)} className={`overflow-hidden rounded border border-[var(--wms-border)] ${k ? "w-20" : "w-32"}`} title={k ? "Phone screenshot" : "Desktop screenshot"}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt={k ? "Phone screenshot" : "Desktop screenshot"} loading="lazy" className="block h-24 w-full object-cover object-top" />
                  </button>
                ) : null,
              )}
            </div>
          )}
        </div>
      ))}
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
    refreshInterval: (d) => (d && (d.messages.some((m) => WORKING.includes(m.status)) || d.design.status === "converting" || d.design.status === "checking" || d.design.check_status === "running" || d.design.check_status === "queued" || d.design.translate_status === "running") ? 4000 : 0),
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
        <span className="font-mono text-[0.68rem] uppercase text-[var(--wms-muted)]">
          {design.status === "checking" || design.check_status === "running" || design.check_status === "queued"
            ? "Checking the email…"
            : design.status === "ready"
              ? design.check_status === "passed"
                ? "Email ready · passed the check"
                : design.check_override
                  ? "Email ready · used anyway"
                  : design.check_status === "failed" || design.check_status === "error"
                    ? "Email not passed yet"
                    : "Email ready"
              : design.status}
        </span>
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
              {m.concept && (!m.variantNo || m.variantNo === 1) && (
                <details className="rounded border border-[var(--wms-border)] p-2 text-xs text-[var(--wms-fg)]" open={m.status === "review"}>
                  <summary className="cursor-pointer font-semibold">
                    The concept{m.creativeModel ? ` · by ${m.creativeModel}` : ""}
                    {m.imageModel ? ` · photos by ${m.imageModel.replace("gpt-image-", "")}` : ""}
                  </summary>
                  <div className="mt-1 flex flex-col gap-1">
                    <p>{m.concept.story}</p>
                    <p>
                      <b>Hero:</b> “{m.concept.hero.headline}”
                    </p>
                    {m.concept.looks.map((l, i) => (
                      <p key={l.id}>
                        <b>
                          Look {i + 1} · {l.name}
                        </b>{" "}
                        ({l.mood}) — {l.copy}
                      </p>
                    ))}
                    <p>
                      <b>Offer:</b> {m.concept.offer.headline} — {m.concept.offer.text}
                    </p>
                    <p>
                      <b>Showroom:</b> {m.concept.showroom.headline} — {m.concept.showroom.text}
                    </p>
                    {m.status === "review" && <p className="text-[var(--wms-muted)]">The hero and the 3 look photos are made after you approve the items.</p>}
                  </div>
                </details>
              )}
              {m.status !== "review" && (!m.variantNo || m.variantNo === 1) && m.shots.some((x) => x.url || x.error) && (
                <div className="flex flex-col gap-1">
                  <span className={label}>Campaign photos made for this email</span>
                  <div className="flex flex-wrap gap-2">
                    {m.shots.map((x) => (
                      <div key={x.id} className={`flex flex-col gap-0.5 text-[0.66rem] text-[var(--wms-muted)] ${x.kind === "hero" ? "w-56 max-md:w-full" : "w-28 max-md:w-[30%]"}`}>
                        {x.url ? (
                          <button type="button" onClick={() => setZoom(x.url)} className="block overflow-hidden rounded border border-[var(--wms-border)]" title="Open full size">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={x.url} alt={x.kind === "hero" ? "Hero photo" : `Look ${x.id.slice(1)} photo`} loading="lazy" className="block h-auto w-full" />
                          </button>
                        ) : (
                          <span className="text-[var(--wms-status-danger-fg)]">Not made: {x.error}</span>
                        )}
                        <span>{x.kind === "hero" ? "Hero" : `Look ${x.id.slice(1)}`}</span>
                        {x.qa && <span className="text-amber-700 dark:text-amber-300">Check still sees: {x.qa}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {m.text && <p className="whitespace-pre-wrap text-sm text-[var(--wms-fg)]">{m.text}</p>}
              {m.status !== "done" && m.status !== "review" && (
                <p className={`text-xs ${m.status === "failed" ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-muted)]"}`}>
                  {m.status === "failed" ? (m.error ?? "Failed") : progressText(m)}
                </p>
              )}
              {m.status === "review" && <ReviewItems designId={id} messageId={m.id} products={m.products} media={m.media} concept={m.concept} onDone={() => void mutate()} />}
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
          {design.status === "converting" && <p className="text-xs text-[var(--wms-muted)]">Writing the email code from the chosen version…</p>}
          {design.html && <CheckPanel design={design} busy={busy} onAction={(action) => run(`check-${action}`, async () => void (await send(`/api/email/designs/${id}/check`, "POST", { action }), await mutate()))} onZoom={setZoom} />}
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
                <LanguagePreview design={design} designId={id} />
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
