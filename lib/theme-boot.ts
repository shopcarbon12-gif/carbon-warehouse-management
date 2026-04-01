/**
 * Blocking boot in <head>: applies color mode + font scale before first paint.
 * Keep in sync with `components/theme/theme-provider.tsx` (`applyDom` + `readStored`).
 */
export type ThemeFontScale = "comfortable" | "expanded";

export const STORAGE_FONT_KEY = "wms_theme_font";
export const STORAGE_COLOR_KEY = "wms_theme_color";

/** Inline script — must set `data-theme` and `.dark` so they are not layout-controlled (avoids React re-applying server `dark`). */
export const WMS_THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;d.classList.remove("wms-text-lg");var f=localStorage.getItem("${STORAGE_FONT_KEY}");if(f==="expanded"){d.classList.add("wms-text-xl");}else{d.classList.remove("wms-text-xl");}var c=localStorage.getItem("${STORAGE_COLOR_KEY}");if(c==="light"){d.dataset.theme="light";d.classList.remove("dark");}else{d.dataset.theme="dark";d.classList.add("dark");}}catch(e){}})();`;

export function normalizeStoredFont(raw: string | null): ThemeFontScale {
  if (raw === "expanded") return "expanded";
  return "comfortable";
}
