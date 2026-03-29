import type { NextConfig } from "next";

/**
 * Optional subpath deploy only: set WMS_BASE_PATH=/some/prefix at build time.
 * Default: app served at / (dedicated Coolify host or localhost).
 */
function resolveBasePath(): string | undefined {
  const v = process.env.WMS_BASE_PATH;
  if (!v || v === "0") return undefined;
  return v.startsWith("/") ? v : `/${v}`;
}

const basePath = resolveBasePath();

const nextConfig: NextConfig = {
  reactCompiler: true,
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
  async headers() {
    if (process.env.NODE_ENV !== "development") {
      return [];
    }
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=0",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
