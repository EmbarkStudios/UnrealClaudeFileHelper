# Stage 1: Build Zoekt binaries
FROM golang:1.24-alpine AS zoekt-builder
RUN apk add --no-cache git
RUN go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest && \
    go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest

# Stage 2: Install Node.js dependencies (compile native modules for Linux)
FROM node:22-slim AS node-builder
RUN apt-get update && apt-get install -y build-essential python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 3: Runtime
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends lsof procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=zoekt-builder /go/bin/zoekt-index /go/bin/zoekt-webserver /usr/local/bin/
COPY --from=node-builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY public/ ./public/
COPY package.json config.docker.json docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=3072"

EXPOSE 3847

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3847/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
