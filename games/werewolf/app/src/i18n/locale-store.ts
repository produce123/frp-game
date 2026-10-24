import { STORAGE_KEY, defaultLocale, type AppLocale } from "./config";

let currentLocale: AppLocale = defaultLocale;
const listeners = new Set<(locale: AppLocale) => void>();

const readLocaleFromStorage = (): AppLocale | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "zh" || raw === "en") return raw;
  } catch {
    // Ignore storage errors
  }
  return null;
};

const resolvePreferredLocale = (fallback: AppLocale = currentLocale): AppLocale => {
  const stored = readLocaleFromStorage();
  if (stored) return stored;

  return fallback;
};

export const getLocale = (): AppLocale => {
  if (typeof window !== "undefined") {
    try {
      const preferred = resolvePreferredLocale();
      if (preferred !== currentLocale) currentLocale = preferred;
    } catch {
      // Ignore URL errors
    }
  }
  return currentLocale;
};

export const setLocale = (locale: AppLocale): void => {
  currentLocale = locale;
  listeners.forEach((listener) => listener(locale));
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Ignore storage errors
    }
  }
};

export const subscribeLocale = (listener: (locale: AppLocale) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const loadLocaleFromStorage = (fallback: AppLocale = currentLocale): AppLocale => {
  if (typeof window === "undefined") {
    currentLocale = fallback;
    return currentLocale;
  }
  try {
    const preferred = resolvePreferredLocale(fallback);
    currentLocale = preferred;
  } catch {
    // Ignore storage errors
  }
  return currentLocale;
};
