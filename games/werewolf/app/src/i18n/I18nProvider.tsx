"use client";

import { NextIntlClientProvider } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultLocale, localeToHtmlLang, type AppLocale } from "./config";
import { getMessages } from "./messages";
import {
  setLocale as setLocaleStore,
  subscribeLocale,
} from "./locale-store";
import { STORAGE_KEY } from "./config";

type I18nProviderProps = {
  children: React.ReactNode;
  initialLocale?: AppLocale;
};

export function I18nProvider({ children, initialLocale = defaultLocale }: I18nProviderProps) {
  const [locale, setLocale] = useState<AppLocale>(initialLocale);
  const didDetectInitialLocaleRef = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeLocale((next) => setLocale(next));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (didDetectInitialLocaleRef.current || typeof window === "undefined") return;
    didDetectInitialLocaleRef.current = true;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "zh" || saved === "en") {
        setLocaleStore(saved);
        return;
      }
    } catch {
      // Ignore storage errors
    }
    if (navigator.language?.toLowerCase().startsWith("zh")) {
      setLocaleStore("zh");
    }
  }, []);

  useEffect(() => {
    setLocaleStore(locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = localeToHtmlLang[locale];
    }
  }, [locale]);

  const messages = useMemo(() => getMessages(locale), [locale]);

  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Shanghai">
      {children}
    </NextIntlClientProvider>
  );
}
