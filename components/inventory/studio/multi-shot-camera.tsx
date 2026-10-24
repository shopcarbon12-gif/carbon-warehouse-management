"use client";

/**
 * Phone camera for Studio / Bulk Studio on a phone (owner, 2026-10-22: "Phone
 * camera should actually open the phone camera to take multiple pictures until
 * clicking Done"). A full-screen rear-camera view: tap the shutter as many times
 * as needed — garment fronts, backs, hang tags — then Done hands every photo
 * back in shooting order, where Bulk Studio sorts them into items at each hang
 * tag and every photo is turned upright, cropped and put in Front / Back like an
 * upload. Desktop keeps the QR hand-off to a phone.
 *
 * Photos are full-resolution where the browser allows (ImageCapture), else a
 * frame of the live video at its largest size. Nothing is uploaded from here.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Shot = { file: File; url: string };

/** Phone-sized screen — where the in-page camera replaces the QR hand-off. */
export function isPhoneScreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

export function MultiShotCamera({ onDone, onClose }: { onDone: (files: File[]) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 4032 }, height: { ideal: 3024 } },
        });
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
        setReady(true);
      } catch (e) {
        setErr(e instanceof Error && e.name === "NotAllowedError" ? "Allow the camera for this page, then try again." : "The camera could not open on this phone.");
      }
    })();
    return () => {
      stop = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /* The photos' object URLs go when the camera closes. */
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;
  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url)), []);

  const take = useCallback(async () => {
    const v = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!v || !track || busy) return;
    setBusy(true);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 120);
    try {
      let blob: Blob | null = null;
      // Full sensor resolution where the browser has ImageCapture (Chrome on Android).
      const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> } }).ImageCapture;
      if (IC) blob = await new IC(track).takePhoto().catch(() => null);
      if (!blob) {
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext("2d")?.drawImage(v, 0, 0);
        blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.92));
      }
      if (!blob) throw new Error("no photo");
      const at = Date.now();
      // lastModified = the moment it was taken (Bulk Studio keeps the shots in the order they come back in).
      const file = new File([blob], `phone-${at}.jpg`, { type: blob.type || "image/jpeg", lastModified: at });
      setShots((s) => [...s, { file, url: URL.createObjectURL(file) }]);
    } catch {
      setErr("That photo did not take — try again.");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const undoLast = () =>
    setShots((s) => {
      const last = s[s.length - 1];
      if (last) URL.revokeObjectURL(last.url);
      return s.slice(0, -1);
    });

  return (
    <div className="fixed inset-0 z-[300] flex flex-col bg-black" role="dialog" aria-label="Phone camera">
      <div className="relative min-h-0 flex-1">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {flash ? <div className="pointer-events-none absolute inset-0 bg-white/70" /> : null}
        <div className="absolute left-0 right-0 top-0 flex items-center justify-between gap-2 p-3 pt-[max(env(safe-area-inset-top),0.75rem)]">
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 items-center rounded-full bg-black/55 px-4 font-mono text-sm text-white"
          >
            Cancel
          </button>
          <span className="rounded-full bg-black/55 px-3 py-1.5 font-mono text-xs text-white">
            {shots.length ? `${shots.length} photo${shots.length === 1 ? "" : "s"}` : "Front, back, hang tag…"}
          </span>
        </div>
        {err ? <p className="absolute left-3 right-3 top-20 rounded-md bg-red-600/90 px-3 py-2 text-center font-mono text-sm text-white">{err}</p> : null}
      </div>
      {shots.length ? (
        <div className="flex gap-2 overflow-x-auto bg-black px-3 py-2">
          {shots.map((s, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={s.url} src={s.url} alt={`Photo ${i + 1}`} className="h-14 w-14 shrink-0 rounded-md object-cover" />
          ))}
        </div>
      ) : null}
      <div className="flex items-center justify-between bg-black px-6 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3">
        <button
          type="button"
          onClick={undoLast}
          disabled={!shots.length}
          className="min-h-11 min-w-16 rounded-full px-3 font-mono text-sm text-white disabled:opacity-30"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => void take()}
          disabled={!ready || busy}
          aria-label="Take photo"
          className="h-20 w-20 rounded-full border-[5px] border-white bg-white/90 active:scale-95 disabled:opacity-40"
        />
        <button
          type="button"
          onClick={() => onDone(shots.map((s) => s.file))}
          disabled={!shots.length}
          className="min-h-11 min-w-16 rounded-full bg-[var(--wms-accent)] px-4 font-mono text-sm font-semibold text-black disabled:opacity-30"
        >
          Done
        </button>
      </div>
    </div>
  );
}
