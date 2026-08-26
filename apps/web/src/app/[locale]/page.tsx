import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound, redirect } from "next/navigation";

import { gymRepository } from "../../server/identity";
import { getSession } from "../../server/session";

export default async function LocalizedHomePage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) {
    notFound();
  }
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  redirect(
    (await gymRepository.hasActivePortalAccess(session.user.id))
      ? `/${locale}/trainee`
      : `/${locale}/dashboard`,
  );
}
