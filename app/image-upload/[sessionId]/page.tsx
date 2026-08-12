"use client";

import { useCallback, useRef, useState } from "react";
import { useParams } from "next/navigation";

/**
 * Carbon Studio phone-camera capture page (public, opened via QR on a phone).
 * Take/choose a product photo → uploads it to the desktop's generation session.
 */
export default function ImageUploadPage() {
  const params = useParams();
  const sessionId = String(params?.sessionId || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [err, setErr] = useState<string>("");

  const onPick = useCallback((f: File | null) => {
    if (!f) return;
    setFile(f);
    setStatus("idle");
    setErr("");
    const r = new FileReader();
    r.onload = () => setPreview(String(r.result || ""));
    r.readAsDataURL(f);
  }, []);

  const upload = useCallback(async () => {
    if (!file) return;
    setStatus("uploading");
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/image-handoff/session/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Upload failed (${res.status})`);
      }
      setStatus("done");
    } catch (e) {
      setStatus("error");
      setErr(e instanceof Error ? e.message : "Upload failed");
    }
  }, [file, sessionId]);

  const box: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0c0f12",
    color: "#e8eaed",
    fontFamily: "system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "24px 16px",
    gap: 16,
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
    maxWidth: 360,
  };

  return (
    <div style={box}>
      <h1 style={{ fontSize: 18, margin: "8px 0" }}>Carbon Studio — item photo</h1>
      {status === "done" ? (
        <>
          <div style={{ fontSize: 44 }}>✓</div>
          <p style={{ textAlign: "center", opacity: 0.85 }}>
            Photo sent to Carbon Studio. You can close this page and continue on your computer.
          </p>
          <button style={{ ...btn, background: "#1e293b", color: "#e8eaed" }} onClick={() => { setStatus("idle"); setPreview(null); setFile(null); }}>
            Send another
          </button>
        </>
      ) : (
        <>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="preview" style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 12, border: "1px solid #243040" }} />
          ) : (
            <p style={{ textAlign: "center", opacity: 0.75, maxWidth: 360 }}>
              Take a clear photo of the product (flat-lay, on a hanger, or worn) to use as the
              generation reference.
            </p>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => onPick(e.target.files?.[0] || null)}
          />
          <button style={btn} onClick={() => inputRef.current?.click()}>
            {preview ? "Retake / choose another" : "📷 Take / choose photo"}
          </button>
          {file ? (
            <button style={btn} disabled={status === "uploading"} onClick={() => void upload()}>
              {status === "uploading" ? "Sending…" : "Send to Carbon Studio"}
            </button>
          ) : null}
          {err ? <p style={{ color: "#f87171", fontSize: 13 }}>{err}</p> : null}
        </>
      )}
    </div>
  );
}
