# ── Build stage ────────────────────────────────────────────────────────────
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine3.19 AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

# Copy dependency files first (rarely change -> better layer caching)
COPY package.json yarn.lock ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/indexer/package.json packages/indexer/
# packages/cli required for yarn workspaces resolution (root has "packages/*")
COPY packages/cli/package.json packages/cli/

# Install all dependencies (including dev)
# --ignore-engines: @eslint/js requires ^22.13.0, Alpine 3.19 ships 22.12.0; devDeps pruned anyway
RUN yarn install --frozen-lockfile --ignore-engines

# Copy source code (changes frequently)
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/server/src packages/server/src
COPY packages/server/tsconfig.json packages/server/
COPY packages/indexer/src packages/indexer/src
COPY packages/indexer/tsconfig.json packages/indexer/

# Build TypeScript (shared first, server second, indexer last)
RUN yarn workspace @paparats/shared build && \
    yarn workspace @paparats/server build && \
    yarn workspace @paparats/indexer build

# Prune devDependencies
RUN yarn install --frozen-lockfile --production --ignore-engines && yarn cache clean

# ── Production stage ───────────────────────────────────────────────────────
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine3.19

WORKDIR /app

# Create non-root user and install git (required for cloning repos)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -h /home/nodejs && \
    apk add --no-cache git

# Create data directories
RUN mkdir -p /data/repos && chown -R nodejs:nodejs /data

# Copy only built artifacts and production dependencies
COPY --from=builder --chown=nodejs:nodejs /app/package.json /app/yarn.lock ./
COPY --from=builder --chown=nodejs:nodejs /app/packages/shared/package.json packages/shared/
COPY --from=builder --chown=nodejs:nodejs /app/packages/shared/dist packages/shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/packages/server/package.json packages/server/
COPY --from=builder --chown=nodejs:nodejs /app/packages/server/dist packages/server/dist
COPY --from=builder --chown=nodejs:nodejs /app/packages/indexer/package.json packages/indexer/
COPY --from=builder --chown=nodejs:nodejs /app/packages/indexer/dist packages/indexer/dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/packages/server/node_modules packages/server/node_modules
COPY --from=builder --chown=nodejs:nodejs /app/packages/indexer/node_modules packages/indexer/node_modules

USER nodejs

EXPOSE 9877

ENV NODE_ENV=production
ENV PORT=9877
ENV REPOS_DIR=/data/repos

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 9877) + '/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

LABEL org.opencontainers.image.title="paparats-indexer"
LABEL org.opencontainers.image.description="Automated repo indexer for Paparats MCP — clones repos and indexes them on a schedule"
LABEL org.opencontainers.image.source="https://github.com/bkbhub/paparats-mcp"

CMD ["node", "packages/indexer/dist/index.js"]
