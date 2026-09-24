# better-sqlite3 is a native module, so it is compiled in a builder stage
# against the same base image the runtime uses.
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && cp -R node_modules /tmp/prod_node_modules
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Runtime needs libstdc++ for the compiled sqlite binding, which the slim
# image already carries; no build toolchain is shipped.
COPY --from=builder /tmp/prod_node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY package.json ./

# The database and the imagery tile cache live here — mount it so they
# survive container updates.
VOLUME ["/data"]
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Runs as root deliberately: Unraid's appdata share is owned by nobody:users, and
# a non-root uid here would fail to write the SQLite file to the mounted volume.
CMD ["node", "dist/index.js"]
