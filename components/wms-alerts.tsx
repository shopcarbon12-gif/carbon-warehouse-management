"use client";

/**
 * Phone/computer alerts for Shopify orders and Studio night-batch results
 * (owner 2026-10-19).
 *
 * - <AlertSoundListener/> sits in the shell: it registers /sw.js and plays a
 *   sound when the service worker reports an alert — a cash-register "ka-ching"
 *   for orders, a three-note chime for Studio, a "ding-dong" doorbell for a
 *   store visitor and a three-note doorbell for a checkout (owner 2026-10-21:
 *   visitors must not sound like orders). It also shows the alert as a card in
 *   the corner until it is closed: Windows often keeps the notification banner
 *   hidden and only the sound got through. The sounds are synthesised, so
 *   there are no audio files; browsers only let a page play sound after the
 *   user has touched it once, so the audio is unlocked on the first tap/click.
 * - <AlertsControl/> sits in the sidebar footer: turn alerts on/off on this
 *   device and send a test. Hidden for users who are not admins (403).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";

type Sound = "orders" | "studio" | "visitor" | "checkout";

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

function tone(a: AudioContext, freq: number, start: number, dur: number, gain: number, type: OscillatorType = "sine") {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(a.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

/** A short metallic "ka" (filtered noise) then two bright bell tones: "ching". */
function kaChing(a: AudioContext) {
  const t = a.currentTime + 0.02;
  const len = Math.floor(a.sampleRate * 0.08);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const n = a.createBufferSource();
  n.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 3200;
  const g = a.createGain();
  g.gain.value = 0.35;
  n.connect(f).connect(g).connect(a.destination);
  n.start(t);
  for (const [fr, at] of [[2637, 0.09], [3520, 0.09], [2637, 0.2], [3951, 0.2]] as const) tone(a, fr, t + at, 0.9, 0.16, "triangle");
}

/** Three soft rising notes (C6 · E6 · G6). */
function chime(a: AudioContext) {
  const t = a.currentTime + 0.02;
  [1046.5, 1318.5, 1568].forEach((fr, i) => tone(a, fr, t + i * 0.16, 0.9, 0.22, "sine"));
}

/** A doorbell: two warm notes, high then low (E5 · C5) — a visitor walked in. */
function doorbell(a: AudioContext, notes: number[] = [659.3, 523.3]) {
  const t = a.currentTime + 0.02;
  notes.forEach((fr, i) => {
    tone(a, fr, t + i * 0.42, 1.3, 0.28, "sine");
    tone(a, fr * 2, t + i * 0.42, 0.6, 0.05, "sine");
  });
}

export function playAlertSound(sound: Sound | null | undefined) {
  const a = audio();
  if (!a) return;
  if (sound === "studio") chime(a);
  else if (sound === "visitor") doorbell(a);
  else if (sound === "checkout") doorbell(a, [659.3, 523.3, 784]);
  else kaChing(a);
}

type AlertCard = { id: string; title: string; body: string; url: string; sound: Sound | null; at: number };

function supported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function AlertSoundListener() {
  const [cards, setCards] = useState<AlertCard[]>([]);
  useEffect(() => {
    if (!supported()) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type !== "wms-alert") return;
      playAlertSound(e.data.sound);
      const card: AlertCard = {
        id: String(e.data.tag || Date.now() + Math.random()),
        title: String(e.data.title || "CarbonWMS"),
        body: String(e.data.body || ""),
        url: String(e.data.url || "/"),
        sound: e.data.sound ?? null,
        at: Date.now(),
      };
      // Newest on top, the same alert never twice, at most five at a time.
      setCards((cs) => [card, ...cs.filter((c) => c.id !== card.id)].slice(0, 5));
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    /* Unlock audio on the first touch so a later alert can sound. */
    const unlock = () => audio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMsg);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  if (!cards.length) return null;
  const close = (id: string) => setCards((cs) => cs.filter((c) => c.id !== id));
  return (
    <div
      className="fixed bottom-4 right-4 z-[130] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 pb-[env(safe-area-inset-bottom)]"
      role="region"
      aria-label="Alerts"
    >
      {cards.map((c) => (
        <div
          key={c.id}
          role="status"
          className={`rounded-lg border bg-[var(--wms-surface)] p-3 shadow-2xl ${
            c.sound === "visitor" || c.sound === "checkout" ? "border-[var(--wms-accent)]" : "border-[var(--wms-border)]"
          }`}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--wms-fg)]">{c.title}</p>
              {c.body ? <p className="mt-0.5 text-xs text-[var(--wms-muted)]">{c.body}</p> : null}
              <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                {new Date(c.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => close(c.id)}
              className="rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
              aria-label="Close alert"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <Link
            href={c.url}
            onClick={() => close(c.id)}
            className="mt-2 inline-block font-mono text-xs text-[var(--wms-accent)] hover:underline max-md:py-2"
          >
            Open →
          </Link>
        </div>
      ))}
    </div>
  );
}

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* Which alerts this device gets — one switch each (owner 2026-10-21). */
const ALERT_KINDS: { id: string; label: string; hint: string }[] = [
  { id: "orders", label: "Shopify orders", hint: "Every paid order" },
  { id: "studio", label: "Studio results", hint: "A night-batch run is ready" },
  { id: "visitor_new", label: "New visitor", hint: "Someone new is on shopcarbon.com" },
  { id: "visitor_back", label: "Visitor is back", hint: "A returning or nicknamed visitor starts a new visit" },
  { id: "visitor_checkout", label: "Started checkout", hint: "A visitor went to checkout" },
  { id: "visitor_cart", label: "Added to cart", hint: "A visitor added something to the cart" },
];
const DEFAULT_KINDS = ["orders", "studio", "visitor_new", "visitor_back", "visitor_checkout"];

export function AlertsControl() {
  const [state, setState] = useState<"loading" | "hidden" | "unsupported" | "off" | "on" | "blocked">("loading");
  const [kinds, setKinds] = useState<string[]>(DEFAULT_KINDS);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [publicKey, setPublicKey] = useState("");

  const refresh = useCallback(async () => {
    if (!supported()) return setState("unsupported");
    const r = await fetch("/api/push", { cache: "no-store" }).catch(() => null);
    if (!r || r.status === 401 || r.status === 403) return setState("hidden");
    const j = (await r.json().catch(() => ({}))) as { publicKey?: string; devices?: { endpoint: string; kinds?: string[] }[] };
    setPublicKey(j.publicKey || "");
    if (Notification.permission === "denied") return setState("blocked");
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    const mine = sub ? (j.devices || []).find((d) => d.endpoint === sub.endpoint) : undefined;
    if (mine?.kinds) setKinds(mine.kinds);
    setState(mine ? "on" : "off");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    setMsg("");
    try {
      audio();
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "blocked" : "off");
        setMsg(perm === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again." : "Alerts were not allowed.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const r = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), kinds }) });
      if (!r.ok) throw new Error(`Could not turn alerts on (HTTP ${r.status})`);
      setState("on");
      setMsg("Alerts are on for this device. Send a test to check the sound.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not turn alerts on.");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setMsg("");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setState("off");
      setMsg("Alerts are off on this device.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string, on: boolean) => {
    const next = on ? [...new Set([...kinds, id])] : kinds.filter((k) => k !== id);
    setBusy(true);
    setMsg("");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) throw new Error("Alerts are not on for this device.");
      const r = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), kinds: next }) });
      if (!r.ok) throw new Error(`Could not save (HTTP ${r.status})`);
      setKinds(next);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const test = async (kind: Sound | "visitor") => {
    setBusy(true);
    setMsg("");
    audio();
    try {
      const r = await fetch("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
      const j = (await r.json().catch(() => ({}))) as { sent?: number };
      setMsg(j.sent ? `Test sent to ${j.sent} device${j.sent === 1 ? "" : "s"}.` : "No device received it — turn alerts on here first.");
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading" || state === "hidden") return null;
  const btn = "font-mono text-sm text-[var(--wms-accent)] hover:underline disabled:opacity-50 max-md:-m-2 max-md:inline-block max-md:p-2";
  return (
    <div className="mb-3 space-y-1">
      <div className="font-mono text-xs uppercase tracking-wide text-[var(--muted)]">
        Alerts · {state === "on" ? "on" : state === "blocked" ? "blocked" : state === "unsupported" ? "not supported here" : "off"}
      </div>
      {state === "off" || state === "blocked" ? (
        <button type="button" className={btn} disabled={busy} onClick={turnOn}>
          Turn on alerts
        </button>
      ) : null}
      {state === "on" ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <button type="button" className={btn} disabled={busy} onClick={() => test("orders")}>
            Test order
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => test("studio")}>
            Test Studio
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => test("visitor")}>
            Test visitor
          </button>
          <button type="button" className={btn} disabled={busy} onClick={turnOff}>
            Turn off
          </button>
        </div>
      ) : null}
      {state === "on" ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {ALERT_KINDS.map((k) => (
            <label key={k.id} className="flex cursor-pointer items-start gap-2 text-sm text-[var(--wms-fg)] max-md:min-h-11">
              <input
                id={`alert-kind-${k.id}`}
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                checked={kinds.includes(k.id)}
                disabled={busy}
                onChange={(e) => void toggle(k.id, e.target.checked)}
              />
              <span>
                {k.label}
                <span className="block font-mono text-[0.68rem] text-[var(--muted)]">{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {state === "unsupported" ? (
        <div className="font-mono text-xs text-[var(--muted)]">Open wms.shopcarbon.com in Chrome to get alerts on this device.</div>
      ) : null}
      {msg ? <div className="font-mono text-xs text-[var(--muted)]">{msg}</div> : null}
    </div>
  );
}
