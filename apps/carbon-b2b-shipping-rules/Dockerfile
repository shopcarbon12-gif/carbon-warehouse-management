FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000
# Session DB (SQLite) lives on the persistent Coolify volume mounted at /data.
RUN mkdir -p /data

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# npm workspaces: the function extension's manifest must exist before npm ci.
COPY extensions/b2b-delivery-rules/package.json ./extensions/b2b-delivery-rules/package.json

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
