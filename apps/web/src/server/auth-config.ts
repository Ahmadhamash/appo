import { prisma } from "@jormall/db/client";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";

function requiredEnvironment(name: "AUTH_SECRET" | "NEXT_PUBLIC_APP_URL"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export const auth = betterAuth({
  advanced: {
    cookiePrefix: "jormall",
    database: { generateId: "uuid" },
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  appName: "JorMall",
  baseURL: requiredEnvironment("NEXT_PUBLIC_APP_URL"),
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    maxPasswordLength: 128,
    minPasswordLength: 12,
  },
  plugins: [nextCookies()],
  rateLimit: { enabled: true, max: 20, storage: "database", window: 60 },
  secret: requiredEnvironment("AUTH_SECRET"),
  session: {
    additionalFields: {
      activeMembershipId: { input: false, required: false, type: "string" },
      activeOrganizationId: { input: false, required: false, type: "string" },
      activeSupportAccessId: { input: false, required: false, type: "string" },
    },
    cookieCache: { enabled: false },
    expiresIn: 60 * 60 * 12,
    updateAge: 60 * 30,
  },
});

export type JorMallSession = typeof auth.$Infer.Session;
