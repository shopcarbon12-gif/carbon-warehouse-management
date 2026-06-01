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
  allowedDevOrigins: ["192.168.1.214"],
  /**
   * Skip Next.js's in-build TypeScript pass when running inside the Coolify
   * Docker image. The 1.9 GB VPS heap-caps tsc at 2048 MB and a full re-check
   * OOM-kills the build (exit 255 right after "Running TypeScript ..."). We
   * already run `npx tsc --noEmit` separately in dev/CI before pushing — that
   * stays authoritative. Local `npm run build` keeps the check enabled.
   */
  ...(dockerBuild ? { typescript: { ignoreBuildErrors: true } } : {}),
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
    /**
     * Menu regroup (2026-05-30): every page now lives under its menu header's
     * path (/inventory/*, /rfid/*, /integrations/*, /settings/*). These
     * permanent redirects keep old bookmarks, deep-links and the mobile app's
     * web entry points working. `:path*` carries through any sub-segments.
     */
    const menuRegroup = [
      { source: "/overview/locations", destination: "/inventory/locations" },
      { source: "/overview/locations/:path*", destination: "/inventory/locations/:path*" },
      { source: "/rfid/cycle-counts", destination: "/inventory/cycle-counts" },
      { source: "/rfid/cycle-counts/:path*", destination: "/inventory/cycle-counts/:path*" },
      { source: "/operations/transfers/out", destination: "/inventory/transfers/out" },
      { source: "/operations/transfers/out/:path*", destination: "/inventory/transfers/out/:path*" },
      { source: "/operations/transfers/in", destination: "/inventory/transfers/in" },
      { source: "/operations/transfers/in/:path*", destination: "/inventory/transfers/in/:path*" },
      { source: "/operations/exceptions", destination: "/rfid/exceptions" },
      { source: "/operations/exceptions/:path*", destination: "/rfid/exceptions/:path*" },
      { source: "/infrastructure/devices", destination: "/rfid/devices" },
      { source: "/infrastructure/devices/:path*", destination: "/rfid/devices/:path*" },
      { source: "/hardware_config", destination: "/rfid/hardware-config" },
      { source: "/hardware_config/:path*", destination: "/rfid/hardware-config/:path*" },
      { source: "/inventory/sync", destination: "/integrations/sync" },
      { source: "/inventory/sync/:path*", destination: "/integrations/sync/:path*" },
      { source: "/infrastructure/lightspeed-sales", destination: "/integrations/lightspeed-sales" },
      {
        source: "/infrastructure/lightspeed-sales/:path*",
        destination: "/integrations/lightspeed-sales/:path*",
      },
      { source: "/infrastructure/settings", destination: "/settings/general-settings" },
      {
        source: "/infrastructure/settings/:path*",
        destination: "/settings/general-settings/:path*",
      },
      /**
       * Tags & Labels regroup (2026-06-01): Print/Commission, Bulk Geiger,
       * Encode Items and Bulk status moved out of /rfid/* and /inventory/*
       * into the dedicated /tags-labels/* tab. /rfid/commissioning → /print.
       */
      { source: "/rfid/commissioning", destination: "/tags-labels/print" },
      { source: "/rfid/commissioning/:path*", destination: "/tags-labels/print/:path*" },
      { source: "/rfid/bulk-geiger", destination: "/tags-labels/bulk-geiger" },
      { source: "/rfid/bulk-geiger/:path*", destination: "/tags-labels/bulk-geiger/:path*" },
      { source: "/rfid/encode-items", destination: "/tags-labels/encode-items" },
      { source: "/rfid/encode-items/:path*", destination: "/tags-labels/encode-items/:path*" },
      { source: "/inventory/bulk-status", destination: "/tags-labels/bulk-status" },
      { source: "/inventory/bulk-status/:path*", destination: "/tags-labels/bulk-status/:path*" },
    ].map((r) => ({ ...r, permanent: true }));

    if (!basePath) return menuRegroup;
    return [
      {
        source: "/",
        destination: basePath,
        permanent: false,
        basePath: false,
      },
      ...menuRegroup,
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
