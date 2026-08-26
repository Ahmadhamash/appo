import { isSupportedLocale, localeDirection } from "@jormall/contracts/locales";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import "../globals.css";

export const metadata: Metadata = {
  title: "JorMall",
};

type LocalizedLayoutProperties = Readonly<{
  children: ReactNode;
  params: Promise<{ locale: string }>;
}>;

export function generateStaticParams() {
  return [{ locale: "en" }, { locale: "ar" }];
}

export default async function LocalizedLayout({ children, params }: LocalizedLayoutProperties) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) {
    notFound();
  }

  return (
    <html dir={localeDirection[locale]} lang={locale}>
      <body>{children}</body>
    </html>
  );
}
