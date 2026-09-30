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
  /* What this device lets a web page do about focus: "tap" = it honours a
     focus point (Android Chrome on most phones); "auto" = continuous
     autofocus only, a tap changes nothing (every iPhone in Safari); "none" =
     no focus control reported at all. The hint under the preview says which,
     instead of promising tap-to-focus everywhere. */
  const [focusSupport, setFocusSupport] = useState<"tap" | "auto" | "none">("none");
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
        // Everything in the one request: the largest frame the device offers
        // AND continuous autofocus. Forcing the track to its reported maximum
        // afterwards (an earlier version did) can make Android pick a fixed-
        // focus camera mode — a sharp preview that never focuses again.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 4096 },
            height: { ideal: 3072 },
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        try {
          const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
          const modes = caps.focusMode ?? [];
          setFocusSupport(
            modes.includes("single-shot") || modes.includes("manual") ? "tap" : modes.includes("continuous") ? "auto" : "none"
          );
          if (modes.includes("continuous")) {
            await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
          }
        } catch {
          /* capabilities are best-effort */
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

  /** Tap on the preview → focus there where the camera honours a focus
   *  point: a single-shot focus at the tap, then back to continuous a moment
   *  later so the lens does not stay locked on that spot. The ring shows
   *  where the tap landed either way. */
  const refocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusAt = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    setFocusRing({ x: e.clientX - box.left, y: e.clientY - box.top, key: Date.now() });
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
    const modes = caps.focusMode ?? [];
    const mode = modes.includes("single-shot") ? "single-shot" : modes.includes("manual") ? "manual" : null;
    if (!mode) return; // continuous-only (or nothing): the camera focuses by itself
    const advanced = [{ focusMode: mode, pointsOfInterest: [{ x, y }] }];
    void track
      .applyConstraints({ advanced: advanced as unknown as MediaTrackConstraintSet[] })
      .catch(() => {});
    if (refocusTimer.current) clearTimeout(refocusTimer.current);
    if (modes.includes("continuous")) {
      refocusTimer.current = setTimeout(() => {
        void track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
      }, 2500);
    }
  }, []);

  useEffect(() => {
    if (!focusRing) return;
    const t = setTimeout(() => setFocusRing(null), 900);
    return () => clearTimeout(t);
  }, [focusRing]);

  /**
   * Shrink a captured photo for transport.
   *
   * The camera is still asked for its highest resolution — that is what makes
   * the shot sharp and correctly focused — but a 4-5 MB full-sensor still then
   * has to cross a phone's uplink, land in R2, and be uploaded again to OpenAI
   * once per panel (four times a run). At 2048 px on the long edge the same
   * photo is ~0.5-1 MB with nothing a garment reference needs thrown away.
   * Anything the browser cannot decode is passed through untouched rather than
   * lost.
   */
  const shrinkForUpload = useCallback(async (blob: Blob, maxDim = 2048, quality = 0.9): Promise<Blob> => {
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ""));
        r.onerror = () => rej(new Error("read"));
        r.readAsDataURL(blob);
      });
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error("decode"));
        im.src = dataUrl;
      });
      const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
      const safeType = /^image\/(jpeg|jpg|png|webp)$/i.test(blob.type);
      if (longest <= maxDim && safeType && blob.size <= 1.5 * 1024 * 1024) return blob;
      const scale = Math.min(1, maxDim / longest);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return blob;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
      return out && out.size > 0 ? out : blob;
    } catch {
      return blob; // undecodable here — let the server decide
    }
  }, []);

  /** Shrink, then add to the tray. false = this phone cannot read the format. */
  const pushShot = useCallback(
    async (raw: Blob): Promise<boolean> => {
      const blob = await shrinkForUpload(raw);
      // The server only accepts jpeg/png/webp; an undecodable HEIC would be
      // "sent successfully" and then fail everywhere downstream.
      if (!/^image\/(jpeg|jpg|png|webp)$/i.test(blob.type)) return false;
      const dataUrl = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ""));
        r.onerror = () => res("");
        r.readAsDataURL(blob);
      });
      setShots((prev) =>
        prev.length >= MAX_PHOTOS ? prev : [...prev, { id: `${Date.now()}-${prev.length}`, dataUrl, blob }],
      );
      return true;
    },
    [shrinkForUpload],
  );

  const [capturing, setCapturing] = useState(false);
  const capture = useCallback(async () => {
    const v = videoRef.current;
    if (!v || shots.length >= MAX_PHOTOS || capturing) return;
    if (!v.videoWidth && !captureRef.current) {
      setErr("The camera is not ready yet — wait a moment, or use the camera app button.");
      return;
    }
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
          await pushShot(blob);
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
      if (blob) await pushShot(blob);
    } finally {
      setCapturing(false);
    }
  }, [shots.length, capturing, pushShot]);

  /* Photos from the camera app or the gallery. Anything that is not already
     JPEG / PNG / WebP (an iPhone's HEIC, mostly) is re-encoded to JPEG here —
     the desktop cannot display HEIC and OpenAI rejects it, so sending it
     "successfully" would only fail later. Safari decodes HEIC natively. */
  /* Camera-app shots and gallery picks go through the same shrink+validate path
     as a live capture, so an iPhone HEIC is re-encoded here (Safari can decode
     it) and one that cannot be decoded is refused up front instead of being
     "sent" and failing downstream. */
  const addFromPicker = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      void (async () => {
        const list = Array.from(files).slice(0, MAX_PHOTOS);
        let skipped = 0;
        for (const f of list) {
          const looksImage = f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name);
          if (!looksImage || !(await pushShot(f))) skipped += 1;
        }
        if (skipped) {
          setErr(
            `${skipped} photo${skipped === 1 ? "" : "s"} could not be read on this phone (unsupported format) — use JPG, or take it with the camera.`,
          );
        }
      })();
    },
    [pushShot],
  );

  const removeShot = (id: string) => setShots((prev) => prev.filter((s) => s.id !== id));

  /* One request per photo. A single 20–30 MB multipart of six full-res stills
     took long enough on mobile for the desktop to collect a partial batch and
     for the operator to close the panel; now each photo is registered as it
     lands, progress is visible, and a failure keeps the unsent ones for a
     retry instead of losing the whole batch. */
  const [sent, setSent] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  /* The server says whether a desktop polled in the last 10 s. "Sent" used
     to mean only "a session row existed" — the photos were stored while no
     computer was listening, and the operator saw nothing. */
  const [listening, setListening] = useState<boolean | null>(null);
  const uploadAll = useCallback(async () => {
    if (!shots.length) return;
    setStatus("uploading");
    setErr("");
    const total = shots.length;
    let done = 0;
    setSent({ done, total });
    for (const s of shots) {
      try {
        const fd = new FormData();
        fd.append("file", s.blob, `photo-${done + 1}.jpg`);
        const res = await fetch(`/api/image-handoff/session/${encodeURIComponent(sessionId)}`, {
          method: "POST",
          body: fd,
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string; listening?: boolean };
        if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
        if (typeof j.listening === "boolean") setListening(j.listening);
        done += 1;
        setSent({ done, total });
        setShots((prev) => prev.filter((x) => x.id !== s.id)); // sent — leaves the tray
      } catch (e) {
        setStatus("error");
        setErr(`${done} of ${total} sent. ${e instanceof Error ? e.message : "Upload failed"} — press Send again to retry the rest.`);
        return;
      }
    }
    setStatus("done");
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
  const uploading = status === "uploading";

  return (
    <div style={box}>
      <h1 style={{ fontSize: 18, margin: "4px 0" }}>Carbon Studio — item photos</h1>

      {/* Live camera — stays mounted through the "sent" screen (hidden), so
          "Take more" comes back to a live preview instead of a black box. */}
      {cam !== "off" ? (
        <div
          style={{
            width: "100%",
            maxWidth: 380,
            position: "relative",
            touchAction: "manipulation",
            display: status === "done" ? "none" : undefined,
          }}
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
                  {focusSupport === "tap"
                    ? "Tap on screen to focus"
                    : "Auto-focus · for tap-to-focus use the camera app button below"}
                  {camInfo ? ` · ${camInfo}` : ""}
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
      ) : null}

      {status === "done" ? (
        <>
          <div style={{ fontSize: 44 }}>{listening === false ? "⚠" : "✓"}</div>
          {listening === false ? (
            <p style={{ textAlign: "center", opacity: 0.9, maxWidth: 360 }}>
              {sent.done} photo{sent.done === 1 ? "" : "s"} saved — <b>but the computer is not listening right now</b>{" "}
              (its QR panel is closed). Nothing is lost: on the computer, open this product&apos;s Studio tab and
              click <b>Add … photos from phone</b>.
            </p>
          ) : (
            <p style={{ textAlign: "center", opacity: 0.85 }}>
              {sent.done} photo{sent.done === 1 ? "" : "s"} sent to Carbon Studio — they appear on the computer
              within a few seconds. Keep going, or close this page.
            </p>
          )}
          <button style={btnAlt} onClick={() => setStatus("idle")}>Take more</button>
        </>
      ) : (
        <>
          {cam === "off" ? (
            <p style={{ textAlign: "center", opacity: 0.75, maxWidth: 360 }}>
              Camera unavailable — use the buttons below to take or choose photos.
            </p>
          ) : null}

          {/* Thumbnails */}
          {shots.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", width: "100%", maxWidth: 380 }}>
              {shots.map((s) => (
                <div key={s.id} style={{ position: "relative" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.dataUrl} alt="shot" style={{ width: 72, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid #243040" }} />
                  <button
                    onClick={() => removeShot(s.id)}
                    disabled={uploading}
                    style={{ position: "absolute", top: -6, right: -6, background: "#0c0f12", color: "#f87171", border: "1px solid #243040", borderRadius: "50%", width: 22, height: 22, fontSize: 12, lineHeight: 1, opacity: uploading ? 0.4 : 1 }}
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
            <button style={btn} disabled={full || capturing || uploading} onClick={() => void capture()}>
              {full ? "Max 6 reached" : capturing ? "Capturing…" : "📷 Capture photo"}
            </button>
          ) : null}
          {/* The phone's own camera app: full sensor resolution, HDR, and
              tap-to-focus on every phone — the sharpest path where the web
              camera cannot focus on demand (all iPhones in Safari). */}
          <button style={cam === "live" ? btnAlt : btn} disabled={full || uploading} onClick={() => cameraInputRef.current?.click()}>
            {full ? "Max 6 reached" : cam === "live" ? "📸 Camera app (sharpest, tap to focus there)" : "📷 Take photo"}
          </button>
          <button style={btnAlt} disabled={full || uploading} onClick={() => galleryInputRef.current?.click()}>
            🖼 Upload from this phone
          </button>

          {shots.length ? (
            <button style={{ ...btn, background: "#e8eaed" }} disabled={status === "uploading"} onClick={() => void uploadAll()}>
              {status === "uploading"
                ? `Sending ${Math.min(sent.done + 1, sent.total)}/${sent.total}…`
                : `⤴ Send ${shots.length} to Carbon Studio`}
            </button>
          ) : null}
          {err ? <p style={{ color: "#f87171", fontSize: 13 }}>{err}</p> : null}
        </>
      )}
    </div>
  );
}
