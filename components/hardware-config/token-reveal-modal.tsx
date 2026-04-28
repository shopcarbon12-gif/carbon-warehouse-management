"use client";

import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, X } from "lucide-react";

type Props = {
  open: boolean;
  agentName: string;
  token: string;
  onClose: () => void;
};

export function TokenRevealModal({ open, agentName, token, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the textarea
      const ta = document.getElementById("cdm-token-readout") as HTMLTextAreaElement | null;
      ta?.select();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-yellow-500/40 bg-[var(--wms-surface)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-mono text-sm font-semibold text-[var(--wms-fg)]">
            <KeyRound className="h-4 w-4 text-yellow-400" />
            New API token for &ldquo;{agentName}&rdquo;
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-3 rounded border border-yellow-500/40 bg-yellow-500/10 p-3">
          <p className="font-mono text-[0.7rem] text-yellow-400/90">
            This token is shown only once. Copy it now and place it in the agent&apos;s
            <code className="mx-1 rounded bg-[var(--wms-surface-elevated)] px-1">.env</code>
            as <code className="ml-0.5 rounded bg-[var(--wms-surface-elevated)] px-1">CARBON_CDM_TOKEN</code>.
            If you lose it, rotate to issue a new one.
          </p>
        </div>
        <textarea
          id="cdm-token-readout"
          value={token}
          readOnly
          rows={3}
          className="w-full select-all rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-2 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:opacity-90"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> Copy token
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
