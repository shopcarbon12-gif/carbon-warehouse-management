"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  normalizeStoredFont,
  STORAGE_COLOR_KEY,
  STORAGE_FONT_KEY,
  type ThemeFontScale,
} from "@/lib/theme-boot";

export type { ThemeFontScale } from "@/lib/theme-boot";

export type ThemeColorMode = "dark" | "light";

export type ThemeCombo = {
  color: ThemeColorMode;
  font: ThemeFontScale;
};

type ThemeContextValue = {
  colorMode: ThemeColorMode;
  fontScale: ThemeFontScale;
  setTheme: (combo: ThemeCombo) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemeCombo {
  if (typeof window === "undefined") {
    return { color: "dark", font: "comfortable" };
  }
  const c = window.localStorage.getItem(STORAGE_COLOR_KEY);
  const f = window.localStorage.getItem(STORAGE_FONT_KEY);
  return {
    color: c === "light" ? "light" : "dark",
    font: normalizeStoredFont(f),
  };
}

function applyDom(combo: ThemeCombo) {
  const root = document.documentElement;
  root.dataset.theme = combo.color;
  if (combo.color === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  root.classList.remove("wms-text-lg");
  if (combo.font === "expanded") {
    root.classList.add("wms-text-xl");
  } else {
    root.classList.remove("wms-text-xl");
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [colorMode, setColorMode] = useState<ThemeColorMode>("dark");
  const [fontScale, setFontScale] = useState<ThemeFontScale>("comfortable");

  useLayoutEffect(() => {
    const s = readStored();
    /* One-time read from localStorage on client; avoids SSR/localStorage mismatch flash. */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional hydration from localStorage
    setColorMode(s.color);
    setFontScale(s.font);
    applyDom(s);
  }, []);

  const setTheme = useCallback((combo: ThemeCombo) => {
    setColorMode(combo.color);
    setFontScale(combo.font);
    try {
      window.localStorage.setItem(STORAGE_COLOR_KEY, combo.color);
      window.localStorage.setItem(STORAGE_FONT_KEY, combo.font);
    } catch {
      /* ignore */
    }
    applyDom(combo);
  }, []);

  const value = useMemo(
    () => ({
      colorMode,
      fontScale,
      setTheme,
    }),
    [colorMode, fontScale, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useWmsTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useWmsTheme must be used within ThemeProvider");
  return ctx;
}
