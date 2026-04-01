/**
 * Theme bootstrap for <html> before React hydrates. Keep logic in sync with `theme-provider.tsx` readStored/applyDom.
 */
export type ThemeFontScale = "comfortable" | "expanded";

export const STORAGE_COLOR_KEY = "wms_theme_color";
export const STORAGE_FONT_KEY = "wms_theme_font";

/** Minified for root layout <script>; mirrors normalizeStoredFont + color branch. */
export const WMS_THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;var c=localStorage.getItem("${STORAGE_COLOR_KEY}");var f=localStorage.getItem("${STORAGE_FONT_KEY}");d.classList.remove("wms-text-lg");if(c==="light"){d.classList.remove("dark");d.dataset.theme="light";}else{d.classList.add("dark");d.dataset.theme="dark";}if(f==="expanded"||f==="large"){d.classList.add("wms-text-xl");}else{d.classList.remove("wms-text-xl");}}catch(e){}})();`;

export function normalizeStoredFont(raw: string | null): ThemeFontScale {
  if (raw === "expanded" || raw === "large") return "expanded";
  return "comfortable";
}
