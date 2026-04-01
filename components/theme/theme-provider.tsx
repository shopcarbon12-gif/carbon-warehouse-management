"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

export type ThemeColorMode = "dark" | "light";
export type ThemeFontScale = "standard" | "large";

export type ThemeCombo = {
  color: ThemeColorMode;
  font: ThemeFontScale;
};

const STORAGE_COLOR = "wms_theme_color";
const STORAGE_FONT = "wms_theme_font";

type ThemeContextValue = {
  colorMode: ThemeColorMode;
  fontScale: ThemeFontScale;
  setTheme: (combo: ThemeCombo) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemeCombo {
  if (typeof window === "undefined") return { color: "dark", font: "standard" };
  const c = window.localStorage.getItem(STORAGE_COLOR);
  const f = window.localStorage.getItem(STORAGE_FONT);
  return {
    color: c === "light" ? "light" : "dark",
    font: f === "large" ? "large" : "standard",
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
  if (combo.font === "large") {
    root.classList.add("wms-text-lg");
  } else {
    root.classList.remove("wms-text-lg");
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [colorMode, setColorMode] = useState<ThemeColorMode>("dark");
  const [fontScale, setFontScale] = useState<ThemeFontScale>("standard");

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
      window.localStorage.setItem(STORAGE_COLOR, combo.color);
      window.localStorage.setItem(STORAGE_FONT, combo.font);
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
