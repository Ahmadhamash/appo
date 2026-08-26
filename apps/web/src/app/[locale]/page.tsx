import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound, redirect } from "next/navigation";

import { getSession } from "../../server/session";

export default async function LocalizedHomePage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) {
    notFound();
  }
  const session = await getSession();
  redirect(session ? `/${locale}/dashboard` : `/${locale}/login`);
}
