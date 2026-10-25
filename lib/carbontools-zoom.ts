/**
 * Inside the CarbonTools phone app (ex-CarbonGradingAI), a picture opens in the
 * app's own full-screen viewer — pinch to zoom, swipe between pictures — the
 * same one its GradingAI, Catalog and Social screens use (owner, 2026-10-25).
 * Anywhere else (desktop, CarbonWMS-PC) this returns false and the page shows
 * its own overlay.
 */
type ZoomBridge = { zoomImage?: (urlsJson: string, index: number) => void };

function bridge(): ZoomBridge | null {
  if (typeof window === "undefined") return null;
  const n = (window as unknown as { CarbonWMSPCNative?: ZoomBridge }).CarbonWMSPCNative;
  return n && typeof n.zoomImage === "function" ? n : null;
}

export function canZoomNatively(): boolean {
  return bridge() !== null;
}

/** blob: URLs live only in this page; the app gets their bytes as a data: URL instead. */
async function portable(url: string): Promise<string> {
  if (url.startsWith("data:") || /^https?:/i.test(url)) return url;
  if (url.startsWith("blob:")) {
    const blob = await (await fetch(url)).blob();
    return await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }
  return new URL(url, window.location.href).href;
}

/** Opens the pictures in the app's viewer; false when not inside CarbonTools. */
export function zoomNatively(urls: string[], index = 0): boolean {
  const b = bridge();
  if (!b || !urls.length) return false;
  void Promise.all(urls.map(portable))
    .then((list) => b.zoomImage!(JSON.stringify(list), Math.max(0, Math.min(index, list.length - 1))))
    .catch(() => {});
  return true;
}
