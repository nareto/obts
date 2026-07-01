FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  OBTS_DATA_DIR=/var/lib/obts \
  OBTS_HOST=0.0.0.0 \
  OBTS_PORT=3000

WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY openapi ./openapi
COPY dashboard ./dashboard
COPY docs ./docs

RUN mkdir -p /var/lib/obts \
  && chown -R node:node /var/lib/obts /app

USER node
EXPOSE 3000
VOLUME ["/var/lib/obts"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node dist/src/cli.js health ready --json >/dev/null || exit 1
CMD ["node", "dist/src/cli.js", "serve"]

