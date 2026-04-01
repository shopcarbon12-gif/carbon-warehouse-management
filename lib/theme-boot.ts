/**
 * Root font bootstrap before React hydrates. Keep in sync with
 * `components/theme/theme-provider.tsx` (normalizeStoredFont + font branch of applyDom).
 */
export type ThemeFontScale = "comfortable" | "expanded";

export const STORAGE_FONT_KEY = "wms_theme_font";

/** Minified; only adjusts font classes (color/dark still from ThemeProvider). */
export const WMS_THEME_FONT_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;d.classList.remove("wms-text-lg");var f=localStorage.getItem("${STORAGE_FONT_KEY}");if(f==="expanded"){d.classList.add("wms-text-xl");}else{d.classList.remove("wms-text-xl");}}catch(e){}})();`;

export function normalizeStoredFont(raw: string | null): ThemeFontScale {
  if (raw === "expanded") return "expanded";
  return "comfortable";
}
