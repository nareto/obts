FROM node:24-bookworm-slim AS node-build
WORKDIR /build/obts
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY src ./src
COPY obsidian-plugin ./obsidian-plugin
COPY frontend ./frontend
COPY scripts ./scripts
RUN npm ci \
    && npm run build \
    && npm prune --omit=dev

FROM rust:1-bookworm AS rust-build
WORKDIR /build/obts
COPY Cargo.toml Cargo.lock ./
COPY crates/obts-bridge/Cargo.toml ./crates/obts-bridge/Cargo.toml
COPY crates/obts-bridge/src ./crates/obts-bridge/src
COPY crates/obts-bridge/migrations ./crates/obts-bridge/migrations
COPY crates/obts-bridge/config ./crates/obts-bridge/config
RUN cargo build --release --locked -p obts_bridge

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 obts-bridge \
    && useradd --system --uid 10001 --gid obts-bridge --home-dir /var/lib/obts-bridge obts-bridge
WORKDIR /app
COPY --from=rust-build /build/obts/target/release/obts_bridge /usr/local/bin/obts-bridge
COPY --from=node-build /build/obts/dist ./obts/dist
COPY --from=node-build /build/obts/node_modules ./obts/node_modules
COPY --from=node-build /build/obts/package.json ./obts/package.json
COPY crates/obts-bridge/config.example.yaml /etc/obts-bridge/config.example.yaml
COPY crates/obts-bridge/entrypoint.sh /usr/local/bin/obts-bridge-entrypoint
RUN chmod 0755 /usr/local/bin/obts-bridge-entrypoint \
    && mkdir -p /var/lib/obts-bridge/vault \
    && chown -R obts-bridge:obts-bridge /var/lib/obts-bridge
ENV CONFIG_PATH=/etc/obts-bridge/config.yaml
EXPOSE 8080
VOLUME ["/var/lib/obts-bridge"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:8080/health/live >/dev/null || exit 1
ENTRYPOINT ["obts-bridge-entrypoint"]
CMD ["obts-bridge"]
