FROM node:24-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
ENV NODE_ENV=production \
    PULSE_NOTIFY_STATE=/data/notify-state.json
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
CMD ["node", "src/index.ts"]
