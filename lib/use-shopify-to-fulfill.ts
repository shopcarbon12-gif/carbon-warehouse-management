"use client";

/**
 * Shopify orders still to fulfil — one poll shared by everything that shows
 * it (the menu count, the home-screen notice), so two components on screen do
 * not mean two calls to Shopify.
 *
 * Re-read every minute, and immediately when the WMS tab comes back into view
 * or the window regains focus: the label is made in Shopify, in another tab,
 * and the count must drop the moment the operator comes back — not up to a
 * minute later. Anything that knows the orders changed can also call
 * refreshShopifyToFulfill(). Only admins may read sales; a 401/403 stops the
 * polling and the value stays null, so nothing is shown.
 */
import { useSyncExternalStore } from "react";

type Money = { amount: string; currencyCode: string };
export type ToFulfill = {
  count: number;
  orders: Array<{ legacyId: string; name: string; createdAt: string; customer: string | null; total: Money | null; items: number }>;
};

let value: ToFulfill | null = null;
let stopped = false;
let inflight = false;
let timer: number | null = null;
const listeners = new Set<() => void>();

async function load() {
  if (stopped || inflight || typeof document === "undefined" || document.visibilityState !== "visible") return;
  inflight = true;
  try {
    const r = await fetch("/api/shopify/sales?badge=1", { cache: "no-store" });
    if (r.status === 401 || r.status === 403) {
      stopped = true;
      return;
    }
    if (!r.ok) return;
    const j = (await r.json()) as { toFulfill?: number; orders?: ToFulfill["orders"] };
    if (typeof j.toFulfill === "number") {
      value = { count: j.toFulfill, orders: j.orders ?? [] };
      listeners.forEach((l) => l());
    }
  } catch {
    /* offline — keep the last value */
  } finally {
    inflight = false;
  }
}

export function refreshShopifyToFulfill() {
  void load();
}

const onWake = () => void load();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void load();
    timer = window.setInterval(load, 60_000);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    }
  };
}

export function useShopifyToFulfill(): ToFulfill | null {
  return useSyncExternalStore(subscribe, () => value, () => null);
}
