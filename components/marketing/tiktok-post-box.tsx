"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, field, label, send, type MarketingPost } from "./marketing-shared";

/**
 * "Post to TikTok" on a Social post. TikTok's Content Sharing Guidelines make
 * the person choose, every time: who can see it (no preset), whether comments
 * / Duet / Stitch are allowed (all off to start, greyed out when the account
 * turned them off), and whether it is promotional. The account it goes to and
 * TikTok's consent line are shown above the button.
 *
 * "Send to TikTok drafts" (owner, 2026-11-14): the video or photos go to the TikTok app's inbox instead;
 * TikTok notifies the account and the owner adds a sound and posts it there. Works before TikTok reviews
 * the app for public posting. A video can't carry the caption that way, so "Copy caption" is offered.
 * The same box sets how CALENDAR posts go to TikTok (drafts or direct).
 */

type Creator = {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoSeconds: number | null;
  sandbox: boolean;
};

const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  FOLLOWER_OF_CREATOR: "Followers",
  MUTUAL_FOLLOW_FRIENDS: "Friends (followers you follow back)",
  SELF_ONLY: "Only me",
};

type Status = { state: "none" | "processing" | "published" | "in_drafts" | "failed"; permalink?: string | null; error?: string | null };

export function TikTokPostBox({ post, caption, hashtags, onDone }: { post: MarketingPost; caption: string; hashtags: string[]; onDone: (text: string) => Promise<void> }) {
  const [openBox, setOpenBox] = useState(false);
  const info = useSWR<{ connected: boolean; creator?: Creator; error?: string }>(openBox ? "/api/marketing/channels/tiktok/creator" : null, fetcher, { revalidateOnFocus: false });
  const target = post.targets.find((t) => t.provider === "tiktok");
  const [status, setStatus] = useState<Status>({
    state: target?.status === "publishing" ? "processing" : target?.status === "published" ? (target.inDrafts ? "in_drafts" : "published") : "none",
  });
  const [copied, setCopied] = useState(false);
  const modeInfo = useSWR<{ mode: "drafts" | "direct" }>(openBox ? "/api/marketing/channels/tiktok/mode" : null, fetcher, { revalidateOnFocus: false });
  const fullText = `${caption.trim()}${hashtags.length ? `\n\n${hashtags.map((h) => `#${h.replace(/^#+/, "")}`).join(" ")}` : ""}`;
  const [privacy, setPrivacy] = useState("");
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [disclose, setDisclose] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [branded, setBranded] = useState(false);
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isVideo = post.format === "reel" && post.media.some((m) => m.kind === "video");
  const c = info.data?.creator;

  // TikTok keeps working after it takes the post: ask where it is every 5 seconds.
  useEffect(() => {
    if (status.state !== "processing") return;
    const t = setInterval(async () => {
      const s = await fetcher<Status>(`/api/marketing/posts/${post.id}/tiktok`).catch(() => null);
      if (!s || s.state === "processing") return;
      setStatus(s);
      if (s.state === "published") await onDone("Posted to TikTok.");
      if (s.state === "in_drafts") await onDone("Sent to your TikTok drafts.");
    }, 5000);
    return () => clearInterval(t);
  }, [status.state, post.id, onDone]);

  // The video's length, to check it against the account's limit.
  useEffect(() => {
    const v = post.media.find((m) => m.kind === "video");
    if (!openBox || !isVideo || !v) return;
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => setVideoSeconds(Math.round(el.duration));
    el.src = v.url;
  }, [openBox, isVideo, post.media]);

  const tooLong = Boolean(isVideo && c?.maxVideoSeconds && videoSeconds && videoSeconds > c.maxVideoSeconds);
  const discloseIncomplete = disclose && !yourBrand && !branded;
  const done = status.state === "processing" || status.state === "published" || status.state === "in_drafts";
  const canPost = Boolean(c) && privacy !== "" && !discloseIncomplete && !tooLong && !busy && !done;

  async function sendDraft() {
    setBusy(true);
    setErr(null);
    try {
      await send(`/api/marketing/posts/${post.id}/tiktok`, "POST", { mode: "drafts", caption, hashtags });
      setStatus({ state: "processing" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "TikTok did not take the draft");
    } finally {
      setBusy(false);
    }
  }

  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Could not copy — select the caption above and copy it by hand");
    }
  }

  async function setMode(mode: "drafts" | "direct") {
    setErr(null);
    try {
      await send("/api/marketing/channels/tiktok/mode", "POST", { mode });
      await modeInfo.mutate({ mode }, { revalidate: false });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change it");
    }
  }

  async function postNow() {
    setBusy(true);
    setErr(null);
    try {
      await send(`/api/marketing/posts/${post.id}/tiktok`, "POST", {
        caption,
        hashtags,
        privacy,
        allowComment,
        allowDuet: isVideo && allowDuet,
        allowStitch: isVideo && allowStitch,
        yourBrand: disclose && yourBrand,
        brandedContent: disclose && branded,
      });
      setStatus({ state: "processing" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "TikTok did not take the post");
    } finally {
      setBusy(false);
    }
  }

  if (!openBox)
    return (
      <button type="button" className={`${btn} self-start border-[var(--wms-border)]`} onClick={() => setOpenBox(true)}>
        {status.state === "published"
          ? "Posted to TikTok ✓"
          : status.state === "in_drafts"
            ? "In your TikTok drafts ✓"
            : status.state === "processing"
              ? "TikTok is working on it…"
              : "TikTok: send to drafts or post…"}
      </button>
    );

  return (
    <div className={`${card} flex flex-col gap-3`}>
      <div className="flex items-center justify-between gap-2">
        <span className={label}>TikTok</span>
        <button type="button" className="text-xs text-[var(--wms-muted)] underline max-md:py-2" onClick={() => setOpenBox(false)}>
          close
        </button>
      </div>

      {info.isLoading && <p className="text-xs text-[var(--wms-muted)]">Asking TikTok about the account…</p>}
      {info.data && !info.data.connected && <p className="text-xs text-[var(--wms-muted)]">TikTok is not connected. Connect it in Social channels.</p>}
      {(info.data?.error || info.error) && <p className="text-xs text-[var(--wms-status-danger-fg)]">{info.data?.error ?? info.error?.message}</p>}

      {c && (
        <>
          <div className="flex items-center gap-2">
            {c.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.avatarUrl} alt="" className="h-9 w-9 rounded-full" />
            )}
            <div className="min-w-0 text-xs text-[var(--wms-fg)]">
              Posting to <b>{c.nickname || "TikTok"}</b>
              {c.username && <span className="text-[var(--wms-muted)]"> @{c.username}</span>}
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded border border-[var(--wms-border)] p-3">
            <span className={label}>Send to TikTok drafts (recommended)</span>
            <p className="text-xs text-[var(--wms-muted)]">
              The {isVideo ? "video" : "photos"} go to the TikTok app&apos;s inbox. TikTok sends you a notification: open it, add a sound, paste the caption, choose
              who can see it (Everyone) and post. Works now, before TikTok reviews the app for public posting.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={`${btn} border-black bg-black text-white dark:border-white dark:bg-white dark:text-black`} disabled={busy || done} onClick={() => void sendDraft()}>
                {busy ? "Sending…" : status.state === "in_drafts" ? "Sent to drafts ✓" : "Send to TikTok drafts"}
              </button>
              <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => void copyCaption()}>
                {copied ? "Copied ✓" : "Copy caption + hashtags"}
              </button>
            </div>
            {status.state === "in_drafts" && (
              <p className="text-xs text-emerald-700 dark:text-emerald-300">
                In your TikTok drafts. In the TikTok app: tap the notification (or Inbox → System notifications) → add a sound → paste the caption → Everyone → Post.
              </p>
            )}
            {modeInfo.data && (
              <label className="flex flex-wrap items-center gap-2 text-xs text-[var(--wms-fg)]">
                <span className={label}>Calendar posts go to TikTok as</span>
                <select className={field} value={modeInfo.data.mode} onChange={(e) => void setMode(e.target.value as "drafts" | "direct")}>
                  <option value="drafts">Drafts in the TikTok app (you post them)</option>
                  <option value="direct">Posted directly (after TikTok reviews the app)</option>
                </select>
              </label>
            )}
          </div>

          <span className={label}>Or post directly</span>

          <div className="flex flex-col gap-1 text-xs text-[var(--wms-muted)]">
            <span className={label}>What goes to TikTok</span>
            <span>
              {isVideo ? "1 video" : `${post.media.filter((m) => m.kind === "image").length} picture(s) as a photo post`} · caption as written above
              {hashtags.length ? ` · ${hashtags.length} hashtag(s)` : ""}
            </span>
            {tooLong && (
              <span className="text-[var(--wms-status-danger-fg)]">
                The video is {videoSeconds}s; this account can post up to {c.maxVideoSeconds}s.
              </span>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className={label}>Who can see this post</span>
            <select className={field} value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
              <option value="" disabled>
                Choose…
              </option>
              {c.privacyOptions.map((p) => {
                const off = (c.sandbox && p !== "SELF_ONLY") || (disclose && branded && p === "SELF_ONLY");
                return (
                  <option key={p} value={p} disabled={off}>
                    {PRIVACY_LABEL[p] ?? p}
                    {disclose && branded && p === "SELF_ONLY" ? " — branded content cannot be private" : ""}
                  </option>
                );
              })}
            </select>
            {c.sandbox && <span className="text-xs text-amber-700 dark:text-amber-300">Until TikTok reviews the app, only &quot;Only me&quot; works.</span>}
          </label>

          <fieldset className="flex flex-col gap-1">
            <span className={label}>Allow people to</span>
            <div className="flex flex-wrap gap-3 text-xs text-[var(--wms-fg)]">
              <label className={`flex items-center gap-1.5 max-md:min-h-11 ${c.commentDisabled ? "opacity-50" : ""}`}>
                <input type="checkbox" className="max-md:h-5 max-md:w-5" checked={allowComment && !c.commentDisabled} disabled={c.commentDisabled} onChange={(e) => setAllowComment(e.target.checked)} />
                Comment
              </label>
              {isVideo && (
                <>
                  <label className={`flex items-center gap-1.5 max-md:min-h-11 ${c.duetDisabled ? "opacity-50" : ""}`}>
                    <input type="checkbox" className="max-md:h-5 max-md:w-5" checked={allowDuet && !c.duetDisabled} disabled={c.duetDisabled} onChange={(e) => setAllowDuet(e.target.checked)} />
                    Duet
                  </label>
                  <label className={`flex items-center gap-1.5 max-md:min-h-11 ${c.stitchDisabled ? "opacity-50" : ""}`}>
                    <input type="checkbox" className="max-md:h-5 max-md:w-5" checked={allowStitch && !c.stitchDisabled} disabled={c.stitchDisabled} onChange={(e) => setAllowStitch(e.target.checked)} />
                    Stitch
                  </label>
                </>
              )}
            </div>
          </fieldset>

          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between gap-2 text-xs text-[var(--wms-fg)] max-md:min-h-11">
              <span>
                <b>Disclose post content</b>
                <span className="block text-[var(--wms-muted)]">Turn on if this post promotes yourself, a brand, product or service.</span>
              </span>
              <input
                type="checkbox"
                className="max-md:h-5 max-md:w-5"
                checked={disclose}
                onChange={(e) => {
                  setDisclose(e.target.checked);
                  if (!e.target.checked) {
                    setYourBrand(false);
                    setBranded(false);
                  }
                }}
              />
            </label>
            {disclose && (
              <div className="flex flex-col gap-2 border-l-2 border-[var(--wms-border)] pl-3 text-xs text-[var(--wms-fg)]">
                <label className="flex items-start gap-1.5 max-md:min-h-11">
                  <input type="checkbox" className="mt-0.5 max-md:h-5 max-md:w-5" checked={yourBrand} onChange={(e) => setYourBrand(e.target.checked)} />
                  <span>
                    <b>Your brand</b>
                    <span className="block text-[var(--wms-muted)]">You are promoting yourself or your own business.</span>
                  </span>
                </label>
                <label className="flex items-start gap-1.5 max-md:min-h-11">
                  <input
                    type="checkbox"
                    className="mt-0.5 max-md:h-5 max-md:w-5"
                    checked={branded}
                    onChange={(e) => {
                      setBranded(e.target.checked);
                      if (e.target.checked && privacy === "SELF_ONLY") setPrivacy("");
                    }}
                  />
                  <span>
                    <b>Branded content</b>
                    <span className="block text-[var(--wms-muted)]">You are promoting another brand or a third party.</span>
                  </span>
                </label>
                {discloseIncomplete ? (
                  <span className="text-amber-700 dark:text-amber-300">You need to say whether this content promotes yourself, a third party, or both.</span>
                ) : (
                  <span className="text-[var(--wms-muted)]">
                    Your {isVideo ? "video" : "photo"} will be labeled &quot;{branded ? "Paid partnership" : "Promotional content"}&quot;.
                  </span>
                )}
              </div>
            )}
          </div>

          <p className="text-xs text-[var(--wms-muted)]">
            By posting, you agree to TikTok&apos;s{" "}
            {disclose && branded && (
              <>
                <a className="underline" href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">
                  Branded Content Policy
                </a>{" "}
                and{" "}
              </>
            )}
            <a className="underline" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">
              Music Usage Confirmation
            </a>
            .
          </p>

          {status.state === "processing" && <p className="text-xs text-sky-700 dark:text-sky-300">TikTok took it and is processing it. It can take a few minutes.</p>}
          {status.state === "published" && (
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              Posted to TikTok.{" "}
              {status.permalink ? (
                <a className="underline" href={status.permalink} target="_blank" rel="noreferrer">
                  Open it
                </a>
              ) : (
                "It is on the profile (private posts have no public link)."
              )}
            </p>
          )}
          {status.state === "failed" && status.error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{status.error}</p>}
          {err && <p className="text-xs text-[var(--wms-status-danger-fg)]">{err}</p>}

          <button type="button" className={`${btn} self-start border-black bg-black text-white dark:border-white dark:bg-white dark:text-black`} disabled={!canPost} onClick={() => void postNow()}>
            {busy ? "Sending…" : "Post now"}
          </button>
        </>
      )}
    </div>
  );
}
