"use client";

import { useMemo, useState } from "react";
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

/**
 * Social → Calendar. Every planned post by day; open one to check the
 * pictures, caption, time, channels and Instagram product tags, then Approve
 * it (or ask for changes). Approval is per post. Nothing publishes while the
 * publish switch is off, and an edit after approval needs a new approval.
 */

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
          key={`${open.id}:${open.status}:${open.scheduledAt}`}
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
  const [askChanges, setAskChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tagList = hashtags.split(/\s+/).filter(Boolean);
  const dirty =
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
    return { caption, hashtags: tagList, scheduledAt: iso, targets };
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
            {post.media.map((md) =>
              md.kind === "video" ? (
                <video key={md.position} src={md.url} poster={md.coverUrl ?? undefined} controls muted playsInline className="h-72 w-auto shrink-0 rounded max-md:h-56" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={md.position} src={md.url} alt={`Slide ${md.position + 1}`} className="h-72 w-auto shrink-0 rounded object-cover max-md:h-56" />
              ),
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
            <span className={label}>Caption</span>
            <textarea className={`${field} min-h-32 font-sans text-[0.8rem]`} value={caption} disabled={locked} onChange={(e) => setCaption(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Hashtags</span>
            <input className={field} value={hashtags} disabled={locked} onChange={(e) => setHashtags(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Date and time (Eastern)</span>
            <input type="datetime-local" className={field} value={when} disabled={locked} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <fieldset className="flex flex-col gap-1">
            <span className={label}>Channels</span>
            <div className="flex flex-wrap gap-3">
              {(["instagram", "facebook"] as const).map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-xs text-[var(--wms-fg)] max-md:min-h-11">
                  <input
                    type="checkbox"
                    className="max-md:h-5 max-md:w-5"
                    checked={targets.includes(t)}
                    disabled={locked}
                    onChange={(e) => setTargets((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))}
                  />
                  {t === "instagram" ? "Instagram (with product tags)" : "Facebook page (with shop link)"}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1">
            <span className={label}>Instagram product tags ({post.tags.length})</span>
            {post.tags.length ? (
              <ul className="flex flex-col gap-0.5 text-xs text-[var(--wms-fg)]">
                {post.tags.map((t, i) => (
                  <li key={`${t.metaProductId}:${i}`} className="flex flex-wrap gap-x-2">
                    <span className="font-mono text-[0.66rem] text-[var(--wms-muted)]">slide {t.mediaPosition + 1}</span>
                    {t.handle ? (
                      <a className="underline" href={`https://shopcarbon.com/products/${t.handle}`} target="_blank" rel="noreferrer">
                        {t.label}
                      </a>
                    ) : (
                      <span>{t.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--wms-muted)]">No product tags.</p>
            )}
          </div>

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

          {err && <p className="text-xs text-[var(--wms-status-danger-fg)]">{err}</p>}

          {!locked && (
            <div className="flex flex-wrap gap-2 border-t border-[var(--wms-border)] pt-3">
              {post.status !== "approved" && post.status !== "cancelled" && (
                <button
                  type="button"
                  className={`${btn} border-emerald-600 bg-emerald-600 text-white`}
                  disabled={busy}
                  onClick={() => {
                    const e = edits();
                    if (e) patch({ ...e, action: "approve" }, "Approved. It goes out at its time while publishing is on.");
                  }}
                >
                  {dirty ? "Save and approve" : "Approve"}
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
