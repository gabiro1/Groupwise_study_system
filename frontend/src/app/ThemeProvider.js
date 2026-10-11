"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

const ThemeContext = createContext(null);
const THEME_KEY = "lien-theme";
const THEME_EVENT = "lien-theme-change";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function getThemeSnapshot() {
  return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

function getServerThemeSnapshot() {
  return "light";
}

function subscribeToTheme(callback) {
  window.addEventListener(THEME_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(THEME_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function ThemeProvider({ children }) {
  const theme = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, getServerThemeSnapshot);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const value = useMemo(() => ({
    theme,
    toggleTheme() {
      const nextTheme = theme === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_KEY, nextTheme);
      applyTheme(nextTheme);
      window.dispatchEvent(new Event(THEME_EVENT));
    },
  }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider.");
  return context;
}
