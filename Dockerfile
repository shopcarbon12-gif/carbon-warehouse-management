# Carbon WMS — standalone Next image; map port 3000 in Coolify and set env in the dashboard.
# Runtime: set DATABASE_URL (and other secrets) in Coolify from your linked Postgres resource.
FROM node:20-alpine AS base

FROM base AS deps
# musl + prebuilt native deps (e.g. sharp) — avoids intermittent install/build failures on Alpine.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
# Some hosts set NODE_ENV/NPM_CONFIG_PRODUCTION during build; devDependencies are required for `next build`.
ENV NPM_CONFIG_PRODUCTION=false
RUN npm ci

FROM base AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_PRODUCTION=false
# CI + low parallelism: fewer concurrent webpack units → lower peak RAM on 2–4GB build hosts.
ENV CI=true
ENV DOCKER_BUILD=1
# React Compiler off in image build (saves large amounts of compile RAM); runtime unchanged.
ENV NEXT_REACT_COMPILER=0
# Heap cap: raise on Coolify only if the build host has RAM (e.g. 8192); 6144 is a common default.
ENV NODE_OPTIONS=--max-old-space-size=6144
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Avoid `npm run build` here: package.json runs db:migrate first, which needs DATABASE_URL.
# Migrations run at container start via docker-entrypoint (WMS_AUTO_MIGRATE) or Coolify hooks.
# Always webpack in Docker (not Turbopack); matches `next build --webpack` recommendations for CI.
RUN node ./node_modules/next/dist/bin/next build --webpack

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && apk add --no-cache libc6-compat postgresql-client su-exec
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY scripts/schema.sql scripts/seed-bootstrap.sql /app/scripts/
COPY scripts/migrations /app/scripts/migrations
COPY scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
# Writable .next/cache; entrypoint runs as root for optional psql migrate/seed, then su-exec nextjs.
RUN chmod +x /app/docker-entrypoint.sh \
  && mkdir -p /app/.next/cache \
  && chown -R nextjs:nodejs /app
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Liveness: /api/health has no DB (see app/api/health/route.ts). Long start-period for Next boot.
HEALTHCHECK --interval=30s --timeout=8s --start-period=90s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
