import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";
import { I18nProvider } from "@/i18n/I18nProvider";
import { defaultLocale, localeToHtmlLang } from "@/i18n/config";
import { getMessages } from "@/i18n/messages";

const defaultMessages = getMessages(defaultLocale);

/*
 * 狼人杀页面挂在平台 `/werewolf/` 下，账号、头像、好友全部来自平台会话。
 * 这里不再有任何 SEO / 推广 / AI 文案（用户明确要求删掉上游那套"AI 狼人杀"营销站）。
 */
export const metadata: Metadata = {
  title: defaultMessages.app.title,
  description: defaultMessages.app.description,
  applicationName: defaultMessages.app.title,
  icons: {
    icon: `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/brand/wolfcha-favicon.svg`,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang={localeToHtmlLang[defaultLocale]} suppressHydrationWarning>
      <body className="antialiased">
        <I18nProvider>
          <Toaster position="top-center" closeButton />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}