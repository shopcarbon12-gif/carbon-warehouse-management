"use client";

import { useCallback, useId, useState } from "react";
import useSWR from "swr";
import { Loader2 } from "lucide-react";

/**
 * "Thank-you code" switch beside "Print a packing slip" (default ON).
 *  ON  → the order's 15%-off-next-order code exists (created now, or when the
 *        slip is printed) and waits on the customer's Rewards page.
 *  OFF → printing creates no code; switching off deletes THIS order's code.
 * Greyed out, with the reason, when a code is not possible.
 */
type State = {
  enabled: boolean;
  blocked: string | null;
  code: string | null;
  endsAt: string | null;
  used: boolean;
  expired: boolean;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error ?? "Could not load");
  return j as State;
};

export function ThankYouToggle({ orderId }: { orderId: string }) {
  const url = `/api/shopify/sales/${orderId}/thank-you-code`;
  const { data, error, mutate } = useSWR<State>(url, fetcher, { revalidateOnFocus: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const uid = useId().replace(/:/g, "");

  const on = !!data?.enabled && !data.blocked;
  const disabled = busy || !data || !!data.blocked;

  const flip = useCallback(async () => {
    if (!data || data.blocked) return;
    const next = !data.enabled;
    if (!next && data.code) {
      const ok = window.confirm(`Delete ${data.code}? The customer will no longer see it on their Rewards page and it stops working at checkout.`);
      if (!ok) return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const j = (await res.json().catch(() => ({}))) as State & { error?: string };
      if (!res.ok) setMsg(j.error ?? "Could not change the code");
      await mutate(res.ok ? j : undefined, { revalidate: !res.ok });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not change the code");
    } finally {
      setBusy(false);
    }
  }, [data, mutate, url]);

  const detail = error
    ? String((error as Error).message)
    : !data
      ? "Loading…"
      : data.blocked
        ? data.code
          ? `${data.code} · ${data.blocked}`
          : data.blocked
        : data.enabled
          ? data.code
            ? `${data.code} · until ${new Date(data.endsAt!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            : "Created when the slip is printed"
          : "Off — printing creates no code";

  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-border)] px-2.5 py-1 max-md:min-h-11">
      <label htmlFor={`thank-you-${uid}`} className="flex cursor-pointer flex-col leading-tight">
        <span className="text-xs font-semibold text-[var(--wms-fg)]">15% thank-you code</span>
        <span className="font-mono text-[0.65rem] text-[var(--wms-muted)] max-md:text-xs" title={msg ?? detail}>
          {msg ? <span className="text-[var(--wms-status-danger-fg)]">{msg}</span> : detail}
        </span>
      </label>
      {busy ? <Loader2 className="h-4 w-4 animate-spin text-[var(--wms-muted)]" aria-hidden /> : null}
      <button
        id={`thank-you-${uid}`}
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="15% thank-you code for this order"
        data-state={on ? "on" : "off"}
        disabled={disabled}
        title={data?.blocked ?? undefined}
        onClick={flip}
        className="wms-toggle-track disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="wms-toggle-thumb" />
      </button>
    </div>
  );
}
