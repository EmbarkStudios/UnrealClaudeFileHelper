# Stage 1: Build Zoekt binaries from source
FROM golang:1.24-alpine AS zoekt-builder

RUN apk add --no-cache git

# Pin to a specific commit for reproducible builds
ARG ZOEKT_VERSION=c747a3bccc2a4a427204ac08eea62a522df6d2ec
RUN git clone https://github.com/sourcegraph/zoekt.git /zoekt && \
    cd /zoekt && \
    git checkout ${ZOEKT_VERSION}

WORKDIR /zoekt
RUN CGO_ENABLED=0 go build -o /out/zoekt-index ./cmd/zoekt-index && \
    CGO_ENABLED=0 go build -o /out/zoekt-webserver ./cmd/zoekt-webserver

# Stage 2: Install Node.js dependencies with native compilation
FROM node:22-slim AS node-builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 3: Runtime image
FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends tini lsof procps && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Zoekt binaries
COPY --from=zoekt-builder /out/zoekt-index /usr/local/bin/zoekt-index
COPY --from=zoekt-builder /out/zoekt-webserver /usr/local/bin/zoekt-webserver

# Copy node_modules from builder
COPY --from=node-builder /app/node_modules ./node_modules

# Copy application source
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config.docker.json ./config.docker.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

# Create data directories
RUN mkdir -p /data/db /data/mirror /data/zoekt-index

EXPOSE 3847

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://localhost:3847/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["./docker-entrypoint.sh"]
