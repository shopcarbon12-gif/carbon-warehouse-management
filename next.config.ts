import type { NextConfig } from "next";

/**
 * Optional subpath deploy: set WMS_BASE_PATH=/prefix at build time.
 * Coolify: serve at / on dedicated host (recommended).
 */
function resolveBasePath(): string | undefined {
  const v = process.env.WMS_BASE_PATH;
  if (!v || v === "0") return undefined;
  return v.startsWith("/") ? v : `/${v}`;
}

const basePath = resolveBasePath();

const nextConfig: NextConfig = {
  output: "standalone",
  ...(basePath ? { basePath } : {}),
  async redirects() {
    if (!basePath) return [];
    return [
      {
        source: "/",
        destination: basePath,
        permanent: false,
        basePath: false,
      },
    ];
  },
};

export default nextConfig;
