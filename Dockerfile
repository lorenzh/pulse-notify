FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS build
RUN apk add --no-cache git
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb
ENV NODE_ENV=production \
    PULSE_NOTIFY_STATE=/data/notify-state.json \
    PULSE_HEALTH_PORT=9100 \
    PULSE_HEALTH_HOST=0.0.0.0
WORKDIR /app
RUN mkdir /data && chown bun:bun /data
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const p = process.env.PULSE_HEALTH_PORT || '9100'; if (!/^\\d{1,5}$/.test(p)) process.exit(1); fetch('http://127.0.0.1:' + p + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "src/index.ts"]
