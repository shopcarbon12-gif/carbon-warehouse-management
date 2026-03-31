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

/** Docker/Coolify builders often OOM with React Compiler + webpack; disable when NEXT_REACT_COMPILER=0. */
const useReactCompiler =
  process.env.NEXT_REACT_COMPILER !== "0" && process.env.NEXT_REACT_COMPILER !== "false";

/** Lower webpack parallelism during image build to reduce peak RAM (DOCKER_BUILD=1 in Dockerfile). */
const dockerBuild = process.env.DOCKER_BUILD === "1" || process.env.DOCKER_BUILD === "true";

const nextConfig: NextConfig = {
  reactCompiler: useReactCompiler,
  output: "standalone",
  /**
   * `proxy.ts` buffers the request body so it can be read in both proxy and route handlers.
   * Default limit is 10MB — large APK uploads to `/api/mobile/upload-apk` were truncated,
   * breaking multipart parsing ("Expected multipart form").
   */
  experimental: {
    proxyClientMaxBodySize: "256mb",
  },
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
  ...(dockerBuild
    ? {
        webpack: (config: { parallelism?: number }) => {
          config.parallelism = 1;
          return config;
        },
      }
    : {}),
};

export default nextConfig;
