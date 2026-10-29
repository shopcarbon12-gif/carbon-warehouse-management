"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useUrlParam } from "@/lib/use-url-param";
import {
  btn,
  card,
  etDay,
  etLocalInput,
  etLocalToIso,
  etWhen,
  fetcher,
  field,
  FORMAT_LABEL,
  label,
  send,
  STATUS_LABEL,
  STATUS_TONE,
  type MarketingPost,
} from "./marketing-shared";
import { TikTokPostBox } from "./tiktok-post-box";
import { CatalogImageLightbox } from "@/components/inventory/catalog/catalog-image-lightbox";
import { zoomNatively } from "@/lib/carbontools-zoom";

/**
 * Social → Calendar. Every planned post by day; open one to check the
 * pictures, caption, time, channels and Instagram product tags, then Approve
 * it (or ask for changes). Approval is per post. Nothing publishes while the
 * publish switch is off, and an edit after approval needs a new approval.
 * "Post to TikTok…" sends one post to TikTok right away (tiktok-post-box.tsx).
 * Approve first runs the caption check (AI tells, 5 hashtags, the first 125
 * characters); when it finds problems the owner fixes them or approves as is.
 */

type AiJob = { id: string; postId: string | null; kind: "write" | "check" | "weekly_review"; input: Record<string, unknown>; status: "queued" | "working" | "done" | "failed" | "dismissed"; result: unknown; error: string | null };
type WrittenSuggestion = { title: string; caption: string; hashtags: string[]; tags: Omit<MarketingPost["tags"][number], "handle">[]; notFound: string[] };
const PASSED: CaptionCheckResult = { ok: true, issues: [], caption: "", hashtags: [] };
type CaptionCheckResult = { ok: boolean; issues: { rule: string; quote: string; fix: string }[]; caption: string; hashtags: string[] };
type Overview = { settings: { publishEnabled: boolean; updatedAt: string | null; updatedBy: string | null }; counts: Record<string, number> };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function MarketingCalendarWorkspace() {
  const [month, setMonth] = useUrlParam("month");
  const [openId, setOpenId] = useUrlParam("post");
  const current = month && /^\d{4}-\d{2}$/.test(month) ? month : monthKey(new Date());
  const [y, m] = current.split("-").map(Number);
  const first = useMemo(() => new Date(Date.UTC(y, m - 1, 1)), [y, m]);
  const from = new Date(Date.UTC(y, m - 1, -6)).toISOString();
  const to = new Date(Date.UTC(y, m, 8)).toISOString();

  const overview = useSWR<Overview>("/api/marketing/overview", fetcher, { refreshInterval: 30_000 });
  const posts = useSWR<{ posts: MarketingPost[] }>(`/api/marketing/posts?from=${from}&to=${to}`, fetcher, { refreshInterval: 30_000 });
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);
  const [busy, setBusy] = useState(false);

  const byDay = useMemo(() => {
    const map = new Map<string, MarketingPost[]>();
    for (const p of posts.data?.posts ?? []) {
      if (!p.scheduledAt) continue;
      const k = etDay(p.scheduledAt);
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    return map;
  }, [posts.data]);

  // Monday-first grid covering the month.
  const days = useMemo(() => {
    const start = new Date(first);
    start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
    const out: { key: string; inMonth: boolean; date: number }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      out.push({ key: d.toISOString().slice(0, 10), inMonth: d.getUTCMonth() === m - 1, date: d.getUTCDate() });
    }
    return out.filter((_, i) => i < 35 || out.slice(35).some((x) => x.inMonth));
  }, [first, m]);

  const open = posts.data?.posts.find((p) => p.id === openId) ?? null;
  const today = etDay(new Date().toISOString());
  const publishOn = overview.data?.settings.publishEnabled ?? false;
  const counts = overview.data?.counts ?? {};
  const waiting = (counts.draft ?? 0) + (counts.changes_requested ?? 0);

  async function setPublish(on: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      await send("/api/marketing/settings", "PATCH", { publishEnabled: on });
      setMsg({ text: on ? "Publishing is on. Approved posts go out at their time." : "Publishing is off. Nothing will be sent." });
      setConfirmOn(false);
      await overview.mutate();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(false);
    }
  }

  /* "+ New post" opens a small form: what kind of post and when (Eastern). The time
     starts at tomorrow's best hour (Instagram followers online); the owner can change both. */
  const [draft, setDraft] = useState<{ format: "image" | "reel" | "story"; when: string } | null>(null);
  async function openNewPost() {
    setMsg(null);
    const best = await fetcher<{ providers: Record<string, { top: { weekday: number; hour: number }[] }> }>("/api/marketing/best-times").catch(() => null);
    const day = etDay(new Date(Date.now() + 86_400_000).toISOString());
    const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
    const hour = best?.providers.instagram?.top.find((t) => t.weekday === wd)?.hour ?? 13;
    setDraft({ format: "image", when: `${day}T${String(hour).padStart(2, "0")}:00` });
  }
  async function newPost() {
    if (!draft) return;
    const iso = etLocalToIso(draft.when);
    if (!iso) return setMsg({ text: "Pick a date and time.", err: true });
    setBusy(true);
    setMsg(null);
    try {
      const title = draft.format === "story" ? "New Story" : draft.format === "reel" ? "New Reel" : "New post";
      const r = await send<{ post: MarketingPost }>("/api/marketing/posts", "POST", { title, format: draft.format, scheduledAt: iso });
      await posts.mutate();
      const day = draft.when.slice(0, 10);
      setMonth(day.slice(0, 7) === current ? month : day.slice(0, 7));
      setOpenId(r.post.id);
      setDraft(null);
      setMsg({
        text:
          draft.format === "reel"
            ? "New Reel made. Add the video, then a picture for its cover, then the caption."
            : draft.format === "story"
              ? "New Story made. Add one 9:16 picture."
              : "New draft made. Add pictures (several make a carousel), then write the caption, or let the AI write it.",
      });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(false);
    }
  }

  function shift(delta: number) {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(monthKey(new Date(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  }

  const monthName = first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 max-md:p-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--wms-fg)]">Social · Calendar</h1>
          <p className="text-xs text-[var(--wms-muted)]">
            {waiting} waiting for approval · {counts.approved ?? 0} approved · {counts.published ?? 0} published
            {counts.failed ? ` · ${counts.failed} failed` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${btn} border-sky-600 bg-sky-600 text-white`} disabled={busy} onClick={() => void (draft ? setDraft(null) : openNewPost())}>
            + New post
          </button>
          <StoriesButton onDone={async () => { await posts.mutate(); }} />
        </div>
        <div className={`${card} flex flex-wrap items-center gap-2`}>
          <span className={`inline-flex items-center gap-1.5 font-mono text-[0.72rem] uppercase ${publishOn ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--wms-muted)]"}`}>
            <span className={`h-2 w-2 rounded-full ${publishOn ? "bg-emerald-500" : "bg-zinc-400"}`} />
            Publishing {publishOn ? "on" : "off"}
          </span>
          {publishOn ? (
            <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={() => setPublish(false)}>
              Turn off
            </button>
          ) : confirmOn ? (
            <>
              <span className="text-xs text-[var(--wms-fg)]">Approved posts will go out at their time.</span>
              <button type="button" className={`${btn} border-emerald-600 bg-emerald-600 text-white`} disabled={busy} onClick={() => setPublish(true)}>
                Yes, turn on
              </button>
              <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setConfirmOn(false)}>
                Not now
              </button>
            </>
          ) : (
            <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setConfirmOn(true)}>
              Turn on
            </button>
          )}
        </div>
      </header>
      {draft && (
        <form
          className={`${card} flex flex-wrap items-end gap-3`}
          onSubmit={(e) => {
            e.preventDefault();
            void newPost();
          }}
        >
          <fieldset className="flex flex-col gap-1">
            <span className="font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">Type</span>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["image", "Post / carousel"],
                  ["reel", "Reel"],
                  ["story", "Story"],
                ] as const
              ).map(([f, l]) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={draft.format === f}
                  className={`${btn} ${draft.format === f ? "border-sky-600 bg-sky-600 text-white" : "border-[var(--wms-border)]"}`}
                  onClick={() => setDraft({ ...draft, format: f })}
                >
                  {l}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">Date and time (Eastern)</span>
            <input type="datetime-local" className={field} value={draft.when} onChange={(e) => setDraft({ ...draft, when: e.target.value })} />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={`${btn} border-sky-600 bg-sky-600 text-white`} disabled={busy}>
              Create
            </button>
            <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}

      <div className="flex items-center gap-2">
        <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => shift(-1)} aria-label="Previous month">
          ‹
        </button>
        <h2 className="min-w-[10rem] text-center text-sm font-semibold text-[var(--wms-fg)]">{monthName}</h2>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => shift(1)} aria-label="Next month">
          ›
        </button>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setMonth(null)}>
          Today
        </button>
      </div>

      {posts.error && <p className="text-xs text-[var(--wms-status-danger-fg)]">Could not load posts: {posts.error.message}</p>}

      {/* Desktop: month grid */}
      <div className="hidden min-w-0 md:block">
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAYS.map((w) => (
            <div key={w} className={`${label} px-1`}>
              {w}
            </div>
          ))}
          {days.map((d) => {
            const list = byDay.get(d.key) ?? [];
            return (
              <div
                key={d.key}
                className={`min-h-28 rounded-md border p-1 ${d.inMonth ? "border-[var(--wms-border)] bg-[var(--wms-surface)]" : "border-transparent bg-[var(--wms-surface)]/40"} ${d.key === today ? "ring-2 ring-sky-500/60" : ""}`}
              >
                <div className={`mb-1 font-mono text-[0.7rem] ${d.inMonth ? "text-[var(--wms-fg)]" : "text-[var(--wms-muted)]"}`}>{d.date}</div>
                <div className="flex flex-col gap-1">
                  {list.map((p) => (
                    <PostChip key={p.id} post={p} onOpen={() => setOpenId(p.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Phone: list of days that have posts */}
      <div className="flex flex-col gap-2 md:hidden">
        {days
          .filter((d) => d.inMonth && byDay.has(d.key))
          .map((d) => (
            <div key={d.key} className={card}>
              <div className={`${label} mb-1`}>
                {new Date(`${d.key}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}
              </div>
              <div className="flex flex-col gap-1">
                {(byDay.get(d.key) ?? []).map((p) => (
                  <PostChip key={p.id} post={p} onOpen={() => setOpenId(p.id)} />
                ))}
              </div>
            </div>
          ))}
        {posts.data && ![...byDay.keys()].some((k) => k.startsWith(current)) && <p className="text-xs text-[var(--wms-muted)]">No posts this month.</p>}
      </div>

      {open && (
        <PostPanel
          // Not keyed on the media: adding a picture must not throw away an unsaved date or caption.
          key={`${open.id}:${open.status}:${open.scheduledAt}:${open.aiStatus}`}
          post={open}
          onClose={() => setOpenId(null)}
          onSaved={async (text) => {
            setMsg({ text });
            await Promise.all([posts.mutate(), overview.mutate()]);
          }}
        />
      )}
    </div>
  );
}

function PostChip({ post, onOpen }: { post: MarketingPost; onOpen: () => void }) {
  const thumb = post.media.find((x) => x.kind === "image")?.url ?? post.media[0]?.coverUrl ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full min-w-0 items-center gap-1.5 rounded border p-1 text-left max-md:min-h-11 ${STATUS_TONE[post.status] ?? ""}`}
    >
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="" className="h-9 w-7 shrink-0 rounded-sm object-cover" loading="lazy" />
      ) : (
        <span className="h-9 w-7 shrink-0 rounded-sm bg-[var(--wms-surface-elevated)]" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.72rem] font-medium">{post.title || FORMAT_LABEL[post.format]}</span>
        <span className="block truncate font-mono text-[0.62rem] opacity-80">
          {post.scheduledAt ? new Date(post.scheduledAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : ""} ·{" "}
          {STATUS_LABEL[post.status] ?? post.status}
        </span>
      </span>
    </button>
  );
}

function PostPanel({ post, onClose, onSaved }: { post: MarketingPost; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const locked = ["publishing", "published", "partly_published"].includes(post.status);
  const [caption, setCaption] = useState(post.caption);
  const [hashtags, setHashtags] = useState(post.hashtags.join(" "));
  const [when, setWhen] = useState(etLocalInput(post.scheduledAt));
  const [targets, setTargets] = useState<string[]>(post.targets.map((t) => t.provider));
  const [note, setNote] = useState(post.note ?? "");
  const [title, setTitle] = useState(post.title);
  const [tags, setTags] = useState<MarketingPost["tags"]>(post.tags);
  const [pick, setPick] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  // Removing or reordering media moves/drops tags on the server: take the saved tags again.
  const mediaKey = post.media.map((x) => x.url + (x.coverUrl ?? "")).join("|");
  const lastMedia = useRef(mediaKey);
  useEffect(() => {
    if (lastMedia.current === mediaKey) return;
    lastMedia.current = mediaKey;
    setTags(post.tags);
    setPick(null);
  }, [mediaKey, post.tags]);
  const [brief, setBrief] = useState("");
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [tagQuery, setTagQuery] = useState("");
  const [found, setFound] = useState<{ metaProductId: string; label: string }[]>([]);
  const [askChanges, setAskChanges] = useState(false);
  // Full-screen picture viewer (tap a picture); on CarbonTools the app's own viewer opens instead.
  const [viewAt, setViewAt] = useState<number | null>(null);
  const viewUrls = post.media.map((m) => (m.kind === "video" ? (m.coverUrl ?? "") : m.url)).filter(Boolean);
  const isStory = post.format === "story";
  // Caption check: the text it was run on, and what it found.
  // A caption the owner took from the check's fix counts as passed.
  const [passedText, setPassedText] = useState<string | null>(null);
  const [pendingApprove, setPendingApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tagList = hashtags.split(/\s+/).filter(Boolean);
  const tagsDirty = JSON.stringify(tags) !== JSON.stringify(post.tags);
  const dirty =
    tagsDirty ||
    title !== post.title ||
    caption !== post.caption ||
    tagList.join(" ") !== post.hashtags.join(" ") ||
    when !== etLocalInput(post.scheduledAt) ||
    [...targets].sort().join(",") !== post.targets.map((t) => t.provider).sort().join(",");

  async function patch(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setErr(null);
    try {
      await send(`/api/marketing/posts/${post.id}`, "PATCH", body);
      await onSaved(ok);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  function edits(): Record<string, unknown> | null {
    if (!dirty) return {};
    const iso = etLocalToIso(when);
    if (!iso) {
      setErr("Pick a valid date and time");
      return null;
    }
    return { caption, hashtags: tagList, scheduledAt: iso, targets, title, ...(tagsDirty ? { tags: tags.map(({ mediaPosition, metaProductId, handle, label, x, y }) => ({ mediaPosition, metaProductId, handle, label, x, y })) } : {}) };
  }

  /* Pictures and videos: upload one at a time (they can be large), remove, move. */
  async function upload(files: FileList | null, role: "media" | "cover" = "media", position = 0) {
    if (!files?.length) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", f);
        fd.set("role", role);
        fd.set("position", String(position));
        const r = await fetch(`/api/marketing/posts/${post.id}/media`, { method: "POST", body: fd });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
      }
      await onSaved(role === "cover" ? "Cover saved." : "Added.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }
  async function mediaCall(method: "DELETE" | "PATCH", body: { position?: number; order?: number[] }, ok: string) {
    setBusy(true);
    setErr(null);
    try {
      const url = `/api/marketing/posts/${post.id}/media${method === "DELETE" ? `?position=${body.position}` : ""}`;
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: method === "PATCH" ? JSON.stringify({ order: body.order }) : undefined });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await onSaved(ok);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  function move(pos: number, delta: number) {
    const order = post.media.map((m) => m.position);
    const i = order.indexOf(pos);
    const j = i + delta;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    void mediaCall("PATCH", { order }, "Moved.");
  }

  /* AI jobs run on the server (ai-jobs.ts): refreshing or leaving the page loses nothing; results wait here. */
  const jobs = useSWR<{ jobs: AiJob[] }>(`/api/marketing/ai/jobs?postId=${post.id}`, fetcher, {
    refreshInterval: (d) => (d?.jobs.some((j) => j.status === "queued" || j.status === "working") ? 3000 : 0),
  });
  const writeJob = jobs.data?.jobs.find((j) => j.kind === "write") ?? null;
  const checkJob = jobs.data?.jobs.find((j) => j.kind === "check") ?? null;
  const checkKey = `${caption}\n#${tagList.map((h) => h.replace(/^#+/, "")).join(" ")}`;
  const checkJobKey = checkJob ? `${String(checkJob.input.caption ?? "")}\n#${((checkJob.input.hashtags as string[] | undefined) ?? []).join(" ")}` : null;
  const checkForText = checkJobKey === checkKey ? checkJob : null;
  const checkFresh = checkForText?.status === "done" ? (checkForText.result as CaptionCheckResult) : passedText === checkKey ? PASSED : null;
  const checking = checkForText?.status === "queued" || checkForText?.status === "working";

  async function aiJob(body: Record<string, unknown>) {
    setErr(null);
    try {
      await send("/api/marketing/ai/jobs", "POST", body);
      await jobs.mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The AI could not start");
    }
  }
  async function dismiss(id: string) {
    await fetch(`/api/marketing/ai/jobs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) }).catch(() => null);
    await jobs.mutate();
  }

  /** Check the caption as it is on screen (unless that exact text is already checked or being checked). */
  function runCheck() {
    if (!caption.trim() || checkForText) return;
    void aiJob({ kind: "check", postId: post.id, caption, hashtags: tagList.map((h) => h.replace(/^#+/, "")) });
  }

  /* Approve: the caption is checked first (unless it passed, or the owner chose to approve it as it is). */
  async function approve(force = false) {
    const e = edits();
    if (!e) return;
    if (!force && caption.trim() && post.format !== "story") {
      if (!checkFresh) {
        setPendingApprove(true);
        runCheck();
        return;
      }
      if (!checkFresh.ok) return;
    }
    setPendingApprove(false);
    await patch({ ...e, action: "approve" }, "Approved. It goes out at its time while publishing is on.");
  }
  // Approve waits for its caption check; it goes ahead when the check passes.
  useEffect(() => {
    if (!pendingApprove) return;
    if (checkForText?.status === "failed") {
      setPendingApprove(false);
      setErr(checkForText.error ?? "The caption check did not finish");
    } else if (checkFresh) {
      setPendingApprove(false);
      if (checkFresh.ok) void approve(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingApprove, checkForText?.status, checkFresh]);

  function applyWritten(sgg: WrittenSuggestion, jobId: string) {
    setTitle(sgg.title || title);
    setCaption(sgg.caption);
    setHashtags(sgg.hashtags.join(" "));
    if (sgg.tags.length) setTags(sgg.tags.map((t) => ({ ...t, handle: null })));
    setAiNote(
      `The AI wrote the title, caption and hashtags${sgg.tags.length ? ` and tagged ${sgg.tags.length} product${sgg.tags.length > 1 ? "s" : ""}` : ""}. Check it, then save.` +
        (sgg.notFound.length ? ` Not in the shop catalog: ${sgg.notFound.join(", ")}.` : ""),
    );
    void dismiss(jobId);
  }
  async function searchCatalog(q: string) {
    setTagQuery(q);
    if (q.trim().length < 2) return setFound([]);
    const r = await fetcher<{ products: { metaProductId: string; label: string }[] }>(`/api/marketing/catalog?q=${encodeURIComponent(q.trim())}`).catch(() => ({ products: [] }));
    setFound(r.products);
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-black/40 max-md:items-stretch" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-[var(--wms-border)] bg-[var(--wms-surface)] max-md:max-w-none max-md:overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-[var(--wms-fg)]">{post.title || FORMAT_LABEL[post.format]}</h2>
            <p className="font-mono text-[0.66rem] text-[var(--wms-muted)]">
              {FORMAT_LABEL[post.format]} · {etWhen(post.scheduledAt)} ET {post.campaign ? `· ${post.campaign}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded border px-2 py-0.5 font-mono text-[0.66rem] uppercase ${STATUS_TONE[post.status] ?? ""}`}>{STATUS_LABEL[post.status] ?? post.status}</span>
            <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 p-3">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {post.media.map((md, i) => (
              <div key={md.position} className="flex shrink-0 flex-col gap-1">
                {md.kind === "video" ? (
                  <video src={md.url} poster={md.coverUrl ?? undefined} controls muted playsInline className="h-72 w-auto rounded max-md:h-56" />
                ) : (
                  <div
                    className={`relative ${pick != null && tags[pick]?.mediaPosition === md.position ? "cursor-crosshair ring-2 ring-sky-500" : ""} rounded`}
                    onClick={(e) => {
                      if (pick == null || locked) {
                        const at = viewUrls.indexOf(md.url);
                        if (!zoomNatively(viewUrls, at)) setViewAt(Math.max(0, at));
                        return;
                      }
                      const r = e.currentTarget.getBoundingClientRect();
                      const x = Math.round(((e.clientX - r.left) / r.width) * 100) / 100;
                      const y = Math.round(((e.clientY - r.top) / r.height) * 100) / 100;
                      setTags((cur) => cur.map((t, k) => (k === pick ? { ...t, mediaPosition: md.position, x, y } : t)));
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={md.url} alt={`Slide ${md.position + 1}`} className={`h-72 w-auto rounded object-cover max-md:h-56 ${pick == null ? "cursor-zoom-in" : ""}`} />
                    {tags.map((t, k) =>
                      t.mediaPosition === md.position ? (
                        // Drag a dot to move its tag (owner, 2026-10-29). The wrapper is the
                        // grab area (44px on phones); the visible dot stays small.
                        <span
                          key={`${t.metaProductId}:${k}`}
                          title={locked ? t.label : `${t.label} — drag to move`}
                          className={`group absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center max-md:h-11 max-md:w-11 ${locked ? "pointer-events-none" : "cursor-grab touch-none active:cursor-grabbing"}`}
                          style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => {
                            if (locked) return;
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            setDragging(k);
                          }}
                          onPointerMove={(e) => {
                            if (dragging !== k) return;
                            const box = e.currentTarget.parentElement?.getBoundingClientRect();
                            if (!box) return;
                            const x = Math.round(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * 100) / 100;
                            const y = Math.round(Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) * 100) / 100;
                            setTags((cur) => cur.map((c, j) => (j === k ? { ...c, x, y } : c)));
                          }}
                          onPointerUp={() => setDragging(null)}
                          onPointerCancel={() => setDragging(null)}
                        >
                          <span className={`h-3 w-3 rounded-full border-2 border-white shadow ${k === pick || k === dragging ? "bg-sky-500" : "bg-black/70"}`} />
                          {dragging === k && (
                            <span className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[0.66rem] text-white">
                              {t.label}
                            </span>
                          )}
                        </span>
                      ) : null,
                    )}
                  </div>
                )}
                {!locked && (
                  <div className="flex items-center gap-1">
                    <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy || i === 0} onClick={() => move(md.position, -1)} aria-label="Move earlier">‹</button>
                    <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy || i === post.media.length - 1} onClick={() => move(md.position, 1)} aria-label="Move later">›</button>
                    {md.kind === "video" && (
                      <label className={`${btn} cursor-pointer border-[var(--wms-border)]`}>
                        Cover
                        <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => void upload(e.target.files, "cover", md.position)} />
                      </label>
                    )}
                    <button type="button" className={`${btn} border-[var(--wms-border)] text-[var(--wms-status-danger-fg)]`} disabled={busy} onClick={() => void mediaCall("DELETE", { position: md.position }, "Removed.")}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
            {!locked && post.media.length < 10 && (
              <label className="flex h-72 w-48 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--wms-border)] text-xs text-[var(--wms-muted)] max-md:h-56">
                <span className="text-2xl">+</span>
                {busy ? "Uploading…" : "Add pictures or a video"}
                <input type="file" accept="image/*,video/mp4,video/quicktime" multiple className="hidden" disabled={busy} onChange={(e) => void upload(e.target.files)} />
              </label>
            )}
          </div>

          {post.approvedBy && (
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              Approved by {post.approvedBy} {post.approvedAt ? `on ${etWhen(post.approvedAt)}` : ""}
            </p>
          )}
          {post.note && (post.status === "changes_requested" || post.aiStatus) && <p className="text-xs text-amber-700 dark:text-amber-300">Changes asked: {post.note}</p>}
          {post.aiStatus && (
            <p className={`${card} text-xs ${post.aiStatus === "failed" ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-fg)]"}`}>
              <span className={`${label} block`}>
                {post.aiStatus === "queued" || post.aiStatus === "working"
                  ? "AI is making the changes…"
                  : post.aiStatus === "picture"
                    ? "AI is making the new picture…"
                    : post.aiStatus === "failed"
                      ? "AI could not finish"
                      : "What the AI changed"}
              </span>
              {post.aiSummary ?? post.aiError ?? ""}
            </p>
          )}

          <label className="flex flex-col gap-1">
            <span className={label}>Title (for the calendar)</span>
            <input className={field} value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
          </label>
          {isStory && <p className="text-xs text-[var(--wms-muted)]">A Story is the picture alone: Instagram and Facebook show no caption, hashtags or product tags on it.</p>}
          {!locked && !isStory && post.media.length > 0 && (
            <div className={`${card} flex flex-col gap-2`}>
              <span className={label}>Write with AI</span>
              <textarea
                className={`${field} min-h-14 font-sans text-[0.8rem]`}
                placeholder="Optional brief: the occasion, the products' names, the mood… The AI looks at the pictures."
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
              />
              <button
                type="button"
                className={`${btn} self-start border-sky-600 text-sky-700 dark:text-sky-300`}
                disabled={busy || writeJob?.status === "queued" || writeJob?.status === "working"}
                onClick={() => void aiJob({ kind: "write", postId: post.id, brief })}
              >
                {writeJob?.status === "queued" || writeJob?.status === "working" ? "The AI is writing…" : "Write caption, hashtags and tags"}
              </button>
              {(writeJob?.status === "queued" || writeJob?.status === "working") && (
                <p className="text-xs text-[var(--wms-muted)]">It runs on the server: keep working, refresh or close the page. The caption waits here when it is ready.</p>
              )}
              {writeJob?.status === "done" && (() => {
                const sgg = writeJob.result as WrittenSuggestion;
                return (
                  <div className="flex flex-col gap-1.5 rounded border border-sky-600/40 p-2 text-xs text-[var(--wms-fg)]">
                    <span className={label}>The AI wrote</span>
                    <b>{sgg.title}</b>
                    <p className="whitespace-pre-wrap">{sgg.caption}</p>
                    <p className="font-mono text-[var(--wms-muted)]">{sgg.hashtags.map((h) => `#${h}`).join(" ")}</p>
                    {sgg.tags.length > 0 && <p className="text-[var(--wms-muted)]">Product tags: {sgg.tags.map((t) => t.label).join(", ")}</p>}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={`${btn} border-sky-600 bg-sky-600 text-white`} onClick={() => applyWritten(sgg, writeJob.id)}>
                        Use it
                      </button>
                      <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => void dismiss(writeJob.id)}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                );
              })()}
              {writeJob?.status === "failed" && (
                <p className="text-xs text-[var(--wms-status-danger-fg)]">
                  {writeJob.error ?? "The AI could not write it"}{" "}
                  <button type="button" className="underline max-md:py-2" onClick={() => void dismiss(writeJob.id)}>
                    dismiss
                  </button>
                </p>
              )}
              {aiNote && <p className="text-xs text-[var(--wms-fg)]">{aiNote}</p>}
            </div>
          )}
          {!isStory && (<>
          <label className="flex flex-col gap-1">
            <span className={label}>Caption</span>
            <textarea className={`${field} min-h-32 font-sans text-[0.8rem]`} value={caption} disabled={locked} onChange={(e) => setCaption(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Hashtags (Instagram allows 5)</span>
            <input className={field} value={hashtags} disabled={locked} onChange={(e) => setHashtags(e.target.value)} />
          </label>
          </>)}
          {!locked && caption.trim() && !isStory && (
            <div className="flex flex-col gap-2">
              <button type="button" className={`${btn} self-start border-[var(--wms-border)]`} disabled={busy || checking} onClick={() => runCheck()}>
                {checking ? "Checking the caption…" : checkFresh?.ok ? "Caption check passed ✓" : "Check caption"}
              </button>
              {checkFresh && !checkFresh.ok && (
                <div className={`${card} flex flex-col gap-2 border-amber-500/60`}>
                  <span className={label}>Caption check · {checkFresh.issues.length} to fix</span>
                  <ul className="flex flex-col gap-1.5 text-xs text-[var(--wms-fg)]">
                    {checkFresh.issues.map((i, k) => (
                      <li key={k}>
                        <b>{i.rule}</b>: &ldquo;{i.quote}&rdquo; <span className="text-[var(--wms-muted)]">→ {i.fix}</span>
                      </li>
                    ))}
                  </ul>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-[var(--wms-muted)] max-md:py-2">See the fixed caption</summary>
                    <p className="mt-1 whitespace-pre-wrap text-[var(--wms-fg)]">{checkFresh.caption}</p>
                    <p className="mt-1 font-mono text-[var(--wms-muted)]">{checkFresh.hashtags.map((h) => `#${h}`).join(" ")}</p>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={`${btn} border-sky-600 text-sky-700 dark:text-sky-300`}
                      onClick={() => {
                        setCaption(checkFresh.caption);
                        setHashtags(checkFresh.hashtags.join(" "));
                        setPassedText(`${checkFresh.caption}\n#${checkFresh.hashtags.join(" ")}`);
                      }}
                    >
                      Use the fixed caption
                    </button>
                    {post.status !== "approved" && post.status !== "cancelled" && (
                      <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={() => void approve(true)}>
                        Approve as it is
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className={label}>Date and time (Eastern)</span>
            <input type="datetime-local" className={field} value={when} disabled={locked} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <fieldset className="flex flex-col gap-1">
            <span className={label}>Channels</span>
            <div className="flex flex-wrap gap-3">
              {(["instagram", "facebook", "bluesky", "tiktok"] as const)
                // Bluesky only shows when a post already uses it (CARBON has no Bluesky account).
                .filter((t) => t !== "bluesky" || targets.includes("bluesky"))
                .filter((t) => !isStory || t === "instagram" || t === "facebook")
                .map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-xs text-[var(--wms-fg)] max-md:min-h-11">
                  <input
                    type="checkbox"
                    className="max-md:h-5 max-md:w-5"
                    checked={targets.includes(t)}
                    disabled={locked}
                    onChange={(e) => setTargets((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))}
                  />
                  {t === "instagram" ? "Instagram (with product tags)" : t === "facebook" ? "Facebook page (with shop link)" : t === "bluesky" ? "Bluesky (300 characters, up to 4 pictures)" : "TikTok (photo post or video)"}
                </label>
              ))}
            </div>
          </fieldset>

          {!isStory && (
          <div className="flex flex-col gap-1">
            <span className={label}>Instagram product tags ({tags.length})</span>
            {tags.length ? (
              <ul className="flex flex-col gap-1 text-xs text-[var(--wms-fg)]">
                {tags.map((t, i) => (
                  <li key={`${t.metaProductId}:${i}`} className={`flex flex-wrap items-center gap-x-2 rounded px-1 ${pick === i ? "bg-sky-500/15" : ""}`}>
                    <span className="font-mono text-[0.66rem] text-[var(--wms-muted)]">slide {t.mediaPosition + 1}</span>
                    {t.handle ? (
                      <a className="underline" href={`https://shopcarbon.com/products/${t.handle}`} target="_blank" rel="noreferrer">
                        {t.label}
                      </a>
                    ) : (
                      <span>{t.label}</span>
                    )}
                    {!locked && (
                      <>
                        <button type="button" className="text-sky-700 underline dark:text-sky-300 max-md:py-2" onClick={() => setPick(pick === i ? null : i)}>
                          {pick === i ? "done placing" : "place on picture"}
                        </button>
                        <button type="button" className="text-[var(--wms-status-danger-fg)] underline max-md:py-2" onClick={() => { setTags((cur) => cur.filter((_, k) => k !== i)); setPick(null); }}>
                          remove
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--wms-muted)]">No product tags.</p>
            )}
            {pick != null && <p className="text-xs text-sky-700 dark:text-sky-300">Click the product on a picture to put the tag there.</p>}
            {!locked && tags.length > 0 && pick == null && <p className="text-xs text-[var(--wms-muted)]">Drag a dot on the picture to move its tag, then Save.</p>}
            {!locked && post.media.some((m) => m.kind === "image") && (
              <div className="flex flex-col gap-1">
                <input className={field} placeholder="Tag a product: type its name…" value={tagQuery} onChange={(e) => void searchCatalog(e.target.value)} />
                {found.length > 0 && (
                  <ul className="flex max-h-40 flex-col overflow-y-auto rounded border border-[var(--wms-border)] text-xs">
                    {found.map((p) => (
                      <li key={p.metaProductId}>
                        <button
                          type="button"
                          className="w-full px-2 py-1 text-left text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] max-md:py-2"
                          onClick={() => {
                            const first = post.media.find((m) => m.kind === "image")?.position ?? 0;
                            if (tags.filter((t) => t.mediaPosition === first).length >= 5) return setErr("Instagram takes at most 5 tags per picture");
                            setTags((cur) => [...cur, { mediaPosition: first, metaProductId: p.metaProductId, handle: null, label: p.label, x: 0.5, y: 0.5 }]);
                            setPick(tags.length);
                            setTagQuery("");
                            setFound([]);
                          }}
                        >
                          {p.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          )}

          {post.targets.some((t) => t.status !== "pending") && (
            <div className="flex flex-col gap-1">
              <span className={label}>Results</span>
              {post.targets.map((t) => (
                <p key={t.provider} className="text-xs text-[var(--wms-fg)]">
                  {t.provider}: {t.status}
                  {t.permalink && (
                    <>
                      {" · "}
                      <a className="underline" href={t.permalink} target="_blank" rel="noreferrer">
                        open post
                      </a>
                    </>
                  )}
                  {t.error && <span className="text-[var(--wms-status-danger-fg)]"> · {t.error}</span>}
                </p>
              ))}
            </div>
          )}

          {viewAt != null && <CatalogImageLightbox images={viewUrls} startIndex={viewAt} alt={post.title} onClose={() => setViewAt(null)} />}
          {post.media.length > 0 && !isStory && <TikTokPostBox post={post} caption={caption} hashtags={tagList} onDone={onSaved} />}

          {err && <p className="text-xs text-[var(--wms-status-danger-fg)]">{err}</p>}

          {!locked && (
            <div className="flex flex-wrap gap-2 border-t border-[var(--wms-border)] pt-3">
              {post.status !== "approved" && post.status !== "cancelled" && (
                <button
                  type="button"
                  className={`${btn} border-emerald-600 bg-emerald-600 text-white`}
                  disabled={busy || checking || pendingApprove}
                  onClick={() => void approve()}
                >
                  {checking || pendingApprove ? "Checking the caption…" : dirty ? "Save and approve" : "Approve"}
                </button>
              )}
              {dirty && (
                <button
                  type="button"
                  className={`${btn} border-[var(--wms-border)]`}
                  disabled={busy}
                  onClick={() => {
                    const e = edits();
                    if (e) patch(e, post.status === "approved" ? "Saved. The post needs a new approval." : "Saved.");
                  }}
                >
                  Save changes
                </button>
              )}
              {post.status !== "changes_requested" && post.status !== "cancelled" && (
                <button type="button" className={`${btn} border-amber-500 text-amber-700 dark:text-amber-300`} disabled={busy} onClick={() => setAskChanges((v) => !v)}>
                  Needs a change
                </button>
              )}
              {post.status === "cancelled" ? (
                <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={() => patch({ action: "reopen" }, "Reopened as a draft.")}>
                  Reopen
                </button>
              ) : (
                <button type="button" className={`${btn} border-[var(--wms-border)] text-[var(--wms-muted)]`} disabled={busy} onClick={() => patch({ action: "cancel" }, "Cancelled. It will not be published.")}>
                  Cancel post
                </button>
              )}
            </div>
          )}
          {askChanges && (
            <div className="flex flex-col gap-2">
              <textarea
                className={`${field} min-h-20 font-sans text-[0.8rem]`}
                placeholder="What should change? Picture, caption, hashtags, time, channels, product tags… The AI does it and sends it back for approval."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className={`${btn} self-start border-amber-500 text-amber-700 dark:text-amber-300`}
                disabled={busy || !note.trim()}
                onClick={() => patch({ action: "request_changes", note }, "Sent to the AI — it makes the changes and sends the post back for your approval.")}
              >
                Send change request
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * "Make Stories": one Story for each coming feed post that has none yet
 * (lib/server/marketing/stories.ts). It runs on the server; the new Stories
 * appear in the calendar as drafts waiting for approval.
 */
function StoriesButton({ onDone }: { onDone: () => Promise<void> }) {
  const { data, mutate } = useSWR<{ jobs: AiJob[] }>("/api/marketing/ai/jobs?kind=stories", fetcher, {
    refreshInterval: (d) => (d?.jobs.some((j) => j.status === "queued" || j.status === "working") ? 4000 : 0),
  });
  const job = data?.jobs[0] ?? null;
  const running = job?.status === "queued" || job?.status === "working";
  const seen = useRef<string | null>(null);
  const r = job?.status === "done" ? (job.result as { created: number; skipped: string[] }) : null;
  // When a run finishes, reload the calendar once so the new Stories show.
  useEffect(() => {
    if (job?.status === "done" && seen.current !== job.id) {
      seen.current = job.id;
      void onDone();
    }
  }, [job?.status, job?.id, onDone]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={`${btn} border-[var(--wms-border)]`}
        disabled={running}
        title="Makes a 9:16 Story (the post's picture with its product name and price) for each coming post, Reel or carousel that has no Story yet, the same evening, as a draft for approval. To make one Story by hand, use + New post → Story."
        onClick={async () => {
          await send("/api/marketing/ai/jobs", "POST", { kind: "stories" }).catch(() => null);
          await mutate();
        }}
      >
        {running ? "Making Stories…" : "Make Stories from posts"}
      </button>
      {r && (
        <span className="text-xs text-[var(--wms-muted)]">
          {r.created
            ? `${r.created} new Stories made (drafts).`
            : "No new Stories: every coming post already has one."}
          {r.skipped.length ? ` Skipped: ${r.skipped.join("; ")}.` : ""}
        </span>
      )}
    </div>
  );
}
