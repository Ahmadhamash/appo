import { z } from "zod";

export const supportedLocales = ["en", "ar"] as const;
export const supportedLocaleSchema = z.enum(supportedLocales);
export type SupportedLocale = z.infer<typeof supportedLocaleSchema>;

export const localeDirection: Readonly<Record<SupportedLocale, "ltr" | "rtl">> = {
  ar: "rtl",
  en: "ltr",
};

export function isSupportedLocale(value: string): value is SupportedLocale {
  return supportedLocaleSchema.safeParse(value).success;
}
