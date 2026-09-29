"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

/**
 * Carbon Studio phone-camera capture page (public, opened via QR on a phone).
 * The rear camera opens immediately at the highest resolution it offers; tap
 * the preview to focus; take up to 6 photos in a row, or pick them from the
 * phone's gallery; then upload them all at once to the desktop's generation
 * session. Falls back to the native file picker if the live camera is
 * unavailable/denied.
 */
const MAX_PHOTOS = 6;
type Shot = { id: string; dataUrl: string; blob: Blob };

/* ImageCapture (Chrome / Android) takes a full-sensor still, which is sharper
   than a frame grabbed off the preview stream. Not in every TS lib. */
type ImageCaptureLike = { takePhoto: (opts?: Record<string, unknown>) => Promise<Blob> };
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

export default function ImageUploadPage() {
  const params = useParams();
  const sessionId = String(params?.sessionId || "");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<ImageCaptureLike | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const [cam, setCam] = useState<"starting" | "live" | "off">("starting");
  const [camInfo, setCamInfo] = useState<string>("");
  const [focusRing, setFocusRing] = useState<{ x: number; y: number; key: number } | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [err, setErr] = useState<string>("");

  // Open the rear camera immediately on load, asking for the largest frame
  // the device offers (the browser picks the closest mode it supports).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 4096 },
            height: { ideal: 3072 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        // Push the track to its own maximum if it reports one (Android Chrome).
        try {
          const caps = (track.getCapabilities?.() ?? {}) as { width?: { max?: number }; height?: { max?: number } };
          if (caps.width?.max && caps.height?.max) {
            await track.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max } });
          }
          // Continuous autofocus while framing; tap-to-focus refines it.
          await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
        } catch {
          /* constraints are best-effort */
        }
        try {
          const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
          captureRef.current = IC && track ? new IC(track) : null;
        } catch {
          captureRef.current = null; // preview still works; capture falls back to a frame grab
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        const s = track.getSettings?.();
        if (s?.width && s?.height) setCamInfo(`${s.width}×${s.height}`);
        setCam("live");
      } catch {
        setCam("off"); // permission denied or no camera → file-picker fallback
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      captureRef.current = null;
    };
  }, []);

  /** Tap on the preview → focus there (where the camera supports it) and
   *  show the ring where the tap landed either way. */
  const focusAt = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    setFocusRing({ x: e.clientX - box.left, y: e.clientY - box.top, key: Date.now() });
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
    const modes = caps.focusMode ?? [];
    const mode = modes.includes("single-shot") ? "single-shot" : modes.includes("manual") ? "manual" : modes.includes("continuous") ? "continuous" : null;
    if (!mode) return;
    const advanced = [{ focusMode: mode, pointsOfInterest: [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }] }];
    void track.applyConstraints({ advanced: advanced as unknown as MediaTrackConstraintSet[] }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!focusRing) return;
    const t = setTimeout(() => setFocusRing(null), 900);
    return () => clearTimeout(t);
  }, [focusRing]);

  const pushShot = useCallback((blob: Blob) => {
    const r = new FileReader();
    r.onload = () =>
      setShots((prev) =>
        prev.length >= MAX_PHOTOS ? prev : [...prev, { id: `${Date.now()}-${prev.length}`, dataUrl: String(r.result || ""), blob }],
      );
    r.readAsDataURL(blob);
  }, []);

  const [capturing, setCapturing] = useState(false);
  const capture = useCallback(async () => {
    const v = videoRef.current;
    if (!v || shots.length >= MAX_PHOTOS || capturing) return;
    setCapturing(true);
    try {
      // Full-resolution still from the sensor when the browser offers it. Some
      // Android builds never settle takePhoto(), so it races a 4 s timeout and
      // the frame grab below takes over.
      const ic = captureRef.current;
      if (ic) {
        const timeout = new Promise<null>((res) => setTimeout(() => res(null), 4000));
        const still = ic
          .takePhoto({ imageWidth: 4096, imageHeight: 3072 })
          .catch(() => ic.takePhoto())
          .catch(() => null);
        const blob = await Promise.race([still, timeout]);
        if (blob && blob.size > 0) {
          pushShot(blob);
          return;
        }
      }
      const w = v.videoWidth || 1080;
      const h = v.videoHeight || 1440;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.95));
      if (blob) pushShot(blob);
    } finally {
      setCapturing(false);
    }
  }, [shots.length, capturing, pushShot]);

  const addFromPicker = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    const readOne = (f: File) =>
      new Promise<Shot | null>((res) => {
        if (!f.type.startsWith("image/")) return res(null);
        const r = new FileReader();
        r.onload = () => res({ id: `${Date.now()}-${Math.round(r.result?.toString().length ?? 0)}`, dataUrl: String(r.result || ""), blob: f });
        r.onerror = () => res(null);
        r.readAsDataURL(f);
      });
    void (async () => {
      const list = Array.from(files).slice(0, MAX_PHOTOS);
      const read = (await Promise.all(list.map(readOne))).filter(Boolean) as Shot[];
      setShots((prev) => [...prev, ...read].slice(0, MAX_PHOTOS));
    })();
  }, []);

  const removeShot = (id: string) => setShots((prev) => prev.filter((s) => s.id !== id));

  const uploadAll = useCallback(async () => {
    if (!shots.length) return;
    setStatus("uploading");
    setErr("");
    try {
      const fd = new FormData();
      shots.forEach((s, i) => fd.append("file", s.blob, `photo-${i + 1}.jpg`));
      const res = await fetch(`/api/image-handoff/session/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Upload failed (${res.status})`);
      }
      setStatus("done");
      setShots([]);
    } catch (e) {
      setStatus("error");
      setErr(e instanceof Error ? e.message : "Upload failed");
    }
  }, [shots, sessionId]);

  const box: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0c0f12",
    color: "#e8eaed",
    fontFamily: "system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "18px 14px",
    gap: 12,
  };
  const btn: React.CSSProperties = {
    background: "#2dd4bf",
    color: "#0c0f12",
    border: "none",
    borderRadius: 10,
    padding: "14px 22px",
    fontSize: 16,
    fontWeight: 700,
    width: "100%",
    maxWidth: 380,
  };
  const btnAlt: React.CSSProperties = { ...btn, background: "#1e293b", color: "#e8eaed" };
  const full = shots.length >= MAX_PHOTOS;

  return (
    <div style={box}>
      <h1 style={{ fontSize: 18, margin: "4px 0" }}>Carbon Studio — item photos</h1>

      {status === "done" ? (
        <>
          <div style={{ fontSize: 44 }}>✓</div>
          <p style={{ textAlign: "center", opacity: 0.85 }}>
            Photos sent to Carbon Studio. Keep going or close this page and continue on your computer.
          </p>
          <button style={btnAlt} onClick={() => setStatus("idle")}>Take more</button>
        </>
      ) : (
        <>
          {/* Live camera */}
          {cam !== "off" ? (
            <div
              style={{ width: "100%", maxWidth: 380, position: "relative", touchAction: "manipulation" }}
              onPointerDown={cam === "live" ? focusAt : undefined}
            >
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                style={{ width: "100%", borderRadius: 12, border: "1px solid #243040", background: "#000", aspectRatio: "3 / 4", objectFit: "cover", display: "block" }}
              />
              {cam === "starting" ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.7 }}>
                  Opening camera…
                </div>
              ) : (
                <div style={{ position: "absolute", left: 0, right: 0, bottom: 8, textAlign: "center", fontSize: 12, opacity: 0.85, textShadow: "0 1px 3px #000", pointerEvents: "none" }}>
                  Tap on screen to focus{camInfo ? ` · ${camInfo}` : ""}
                </div>
              )}
              {focusRing ? (
                <div
                  key={focusRing.key}
                  style={{
                    position: "absolute",
                    left: focusRing.x - 32,
                    top: focusRing.y - 32,
                    width: 64,
                    height: 64,
                    border: "2px solid #2dd4bf",
                    borderRadius: 8,
                    boxShadow: "0 0 0 1px #0c0f12",
                    pointerEvents: "none",
                  }}
                />
              ) : null}
            </div>
          ) : (
            <p style={{ textAlign: "center", opacity: 0.75, maxWidth: 360 }}>
              Camera unavailable — use the buttons below to take or choose photos.
            </p>
          )}

          {/* Thumbnails */}
          {shots.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", width: "100%", maxWidth: 380 }}>
              {shots.map((s) => (
                <div key={s.id} style={{ position: "relative" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.dataUrl} alt="shot" style={{ width: 72, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid #243040" }} />
                  <button
                    onClick={() => removeShot(s.id)}
                    style={{ position: "absolute", top: -6, right: -6, background: "#0c0f12", color: "#f87171", border: "1px solid #243040", borderRadius: "50%", width: 22, height: 22, fontSize: 12, lineHeight: 1 }}
                    aria-label="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <p style={{ fontSize: 12, opacity: 0.7 }}>{shots.length}/{MAX_PHOTOS} photos</p>

          {/* Capture / pick. Two inputs: with `capture` the OS opens the camera
              app; without it, the gallery / file chooser. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { addFromPicker(e.target.files); e.target.value = ""; }}
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { addFromPicker(e.target.files); e.target.value = ""; }}
          />
          {cam === "live" ? (
            <button style={btn} disabled={full || capturing} onClick={() => void capture()}>
              {full ? "Max 6 reached" : capturing ? "Capturing…" : "📷 Capture photo"}
            </button>
          ) : (
            <button style={btn} disabled={full} onClick={() => cameraInputRef.current?.click()}>
              {full ? "Max 6 reached" : "📷 Take photo"}
            </button>
          )}
          <button style={btnAlt} disabled={full} onClick={() => galleryInputRef.current?.click()}>
            🖼 Upload from this phone
          </button>

          {shots.length ? (
            <button style={{ ...btn, background: "#e8eaed" }} disabled={status === "uploading"} onClick={() => void uploadAll()}>
              {status === "uploading" ? "Sending…" : `⤴ Send ${shots.length} to Carbon Studio`}
            </button>
          ) : null}
          {err ? <p style={{ color: "#f87171", fontSize: 13 }}>{err}</p> : null}
        </>
      )}
    </div>
  );
}
