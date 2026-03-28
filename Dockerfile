# Carbon WMS — standalone Next image; map port 3000 in Coolify and set env in the dashboard.
# Runtime: set DATABASE_URL (and other secrets) in Coolify from your linked Postgres resource.
FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && apk add --no-cache postgresql-client su-exec
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY scripts/schema.sql scripts/seed-bootstrap.sql /app/scripts/
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
