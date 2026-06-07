"use client";

import { useEffect } from "react";
import { X as XIcon } from "lucide-react";

/**
 * Large in-app image preview for the catalog. Clicking a product picture
 * (item popup or matrix gallery) opens this full-window overlay instead of
 * navigating away. The image itself is a Shopify CDN URL — never re-hosted.
 *
 * Closes on backdrop click, the X, or Escape. Rendered above the catalog
 * modals (z-[120]) so it sits on top of the item/matrix dialogs.
 */
export function CatalogImageLightbox({
  url,
  alt,
  onClose,
}: {
  url: string;
  alt?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-4">
      <button
        type="button"
        aria-label="Close preview"
        className="absolute inset-0 h-full w-full cursor-zoom-out"
        onClick={onClose}
      />
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute right-4 top-4 z-[121] rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <XIcon className="h-5 w-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt || "Product image"}
        className="relative z-[121] max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
      />
    </div>
  );
}
