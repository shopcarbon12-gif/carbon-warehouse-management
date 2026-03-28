import type { NextConfig } from "next";

/**
 * Optional subpath deploy only: set WMS_BASE_PATH=/some/prefix at build time.
 * Default: app served at / (own Coolify host or localhost — never mixed with carbon-gen).
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
};

export default nextConfig;
