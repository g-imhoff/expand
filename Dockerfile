FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY test test
COPY examples examples
COPY tsconfig.json tsconfig.workspace.json eslint.config.mjs knip.jsonc ./
RUN npm run build

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN useradd --create-home --uid 10001 expand && mkdir -p /data && chown expand:expand /data && chmod 700 /data
VOLUME /data
EXPOSE 3210
ENV EXPAND_HOST=0.0.0.0 EXPAND_PORT=3210 NODE_ENV=production
STOPSIGNAL SIGTERM
USER expand
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD node dist/expand health --data-dir /data || exit 1
CMD ["node", "dist/expand-server", "--keep-running", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "3210"]
