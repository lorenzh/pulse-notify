FROM node:24-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
ENV NODE_ENV=production \
    PULSE_NOTIFY_STATE=/data/notify-state.json \
    PULSE_HEALTH_PORT=9100 \
    PULSE_HEALTH_HOST=0.0.0.0
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9100/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/index.ts"]
