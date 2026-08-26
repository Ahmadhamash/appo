import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client";

type PrismaGlobal = typeof globalThis & {
  jormallPrisma?: PrismaClient;
};

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required.");
  }
  return value;
}

export function createPrismaClient(connectionString = databaseUrl()): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

const prismaGlobal = globalThis as PrismaGlobal;

export const prisma = prismaGlobal.jormallPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.jormallPrisma = prisma;
}
