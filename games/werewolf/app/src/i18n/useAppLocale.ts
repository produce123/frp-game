"use client";

import { useLocale } from "next-intl";
import { useCallback } from "react";
import { defaultLocale, isSupportedLocale, type AppLocale } from "./config";
import { setLocale } from "./locale-store";

export function useAppLocale() {
  const intlLocale = useLocale();
  const locale: AppLocale = isSupportedLocale(intlLocale) ? intlLocale : defaultLocale;

  const updateLocale = useCallback((nextLocale: AppLocale) => {
    setLocale(nextLocale);
  }, []);

  return { locale, setLocale: updateLocale };
}
