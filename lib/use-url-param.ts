"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Bind a popup window's open state / record id to a URL query param so a
 * manual browser refresh (or a shared link) reopens the SAME window instead
 * of dropping the operator back on the page.
 *
 *   const [sku, setSku] = useUrlParam("sku");      // "…" | null
 *   setSku(row.custom_sku_id)   // open  → ?sku=<id>
 *   setSku(null)                // close → param removed
 *
 * - Read: useSyncExternalStore over window.location.search. The server
 *   snapshot is "" (window closed), so SSR/hydration stay consistent and no
 *   Suspense boundary is required (unlike next/navigation's useSearchParams,
 *   which would fail the build on statically rendered pages). The client
 *   snapshot takes over right after hydration → the window reopens.
 * - Write: native history.replaceState (which Next's App Router integrates
 *   with) + a local event so every hook instance re-reads — instant, no RSC
 *   refetch, no history-stack spam. Other params on the URL are preserved.
 * - Boolean windows: store "1"; truthiness of the value is the open flag.
 * - Never put secrets (tokens, one-time reveals) or unsaved form drafts in
 *   the URL — those windows stay in plain React state.
 */
const CHANGE_EVENT = "wms:urlparam";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}
const getSnapshot = () => window.location.search;
const getServerSnapshot = () => "";

export function useUrlParam(key: string): [string | null, (value: string | null) => void] {
  const search = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const value = search ? new URLSearchParams(search).get(key) : null;

  const set = useCallback(
    (next: string | null) => {
      if (typeof window === "undefined") return;
      const sp = new URLSearchParams(window.location.search);
      if (next === null || next === "") sp.delete(key);
      else sp.set(key, next);
      const qs = sp.toString();
      const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", url);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [key],
  );

  return [value, set];
}

/** Convenience for open/closed windows without an id. */
export function useUrlFlag(key: string): [boolean, (open: boolean) => void] {
  const [v, set] = useUrlParam(key);
  const setOpen = useCallback((open: boolean) => set(open ? "1" : null), [set]);
  return [v !== null, setOpen];
}
