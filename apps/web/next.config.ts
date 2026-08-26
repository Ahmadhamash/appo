import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  async redirects() {
    return [
      {
        destination: "/en",
        permanent: false,
        source: "/",
      },
    ];
  },
  transpilePackages: [
    "@jormall/ai",
    "@jormall/auth",
    "@jormall/contracts",
    "@jormall/db",
    "@jormall/domain",
    "@jormall/ui",
  ],
};

export default nextConfig;
