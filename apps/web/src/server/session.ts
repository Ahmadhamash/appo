import "server-only";

import { auth, type JorMallSession } from "./auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function getSession(): Promise<JorMallSession | null> {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession(locale: string): Promise<JorMallSession> {
  const session = await getSession();
  if (!session) {
    redirect(`/${locale}/login`);
  }
  return session;
}
