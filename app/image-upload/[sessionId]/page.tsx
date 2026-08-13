"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

/**
 * Carbon Studio phone-camera capture page (public, opened via QR on a phone).
 * The rear camera opens immediately; take up to 6 photos in a row, then upload
 * them all at once to the desktop's generation session. Falls back to the
 * native file picker if the live camera is unavailable/denied.
 */
const MAX_PHOTOS = 6;
type Shot = { id: string; dataUrl: string; blob: Blob };

export default function ImageUploadPage() {
  const params = useParams();
  const sessionId = String(params?.sessionId || "");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cam, setCam] = useState<"starting" | "live" | "off">("starting");
  const [shots, setShots] = useState<Shot[]>([]);
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [err, setErr] = useState<string>("");

  // Open the rear camera immediately on load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setCam("live");
      } catch {
        setCam("off"); // permission denied or no camera → file-picker fallback
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const capture = useCallback(() => {
    const v = videoRef.current;
    if (!v || shots.length >= MAX_PHOTOS) return;
    const w = v.videoWidth || 1080;
    const h = v.videoHeight || 1440;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        setShots((prev) =>
          prev.length >= MAX_PHOTOS ? prev : [...prev, { id: `${Date.now()}-${prev.length}`, dataUrl, blob }],
        );
      },
      "image/jpeg",
      0.9,
    );
  }, [shots.length]);

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
            <div style={{ width: "100%", maxWidth: 380, position: "relative" }}>
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                style={{ width: "100%", borderRadius: 12, border: "1px solid #243040", background: "#000", aspectRatio: "3 / 4", objectFit: "cover" }}
              />
              {cam === "starting" ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.7 }}>
                  Opening camera…
                </div>
              ) : null}
            </div>
          ) : (
            <p style={{ textAlign: "center", opacity: 0.75, maxWidth: 360 }}>
              Camera unavailable — use the button below to take or choose photos.
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

          {/* Capture / pick */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { addFromPicker(e.target.files); e.target.value = ""; }}
          />
          {cam === "live" ? (
            <button style={btn} disabled={shots.length >= MAX_PHOTOS} onClick={capture}>
              {shots.length >= MAX_PHOTOS ? "Max 6 reached" : "📷 Capture photo"}
            </button>
          ) : (
            <button style={btn} disabled={shots.length >= MAX_PHOTOS} onClick={() => fileRef.current?.click()}>
              {shots.length >= MAX_PHOTOS ? "Max 6 reached" : "📷 Take / choose photos"}
            </button>
          )}

          {shots.length ? (
            <button style={btnAlt} disabled={status === "uploading"} onClick={() => void uploadAll()}>
              {status === "uploading" ? "Sending…" : `⤴ Upload all (${shots.length})`}
            </button>
          ) : null}
          {err ? <p style={{ color: "#f87171", fontSize: 13 }}>{err}</p> : null}
        </>
      )}
    </div>
  );
}
