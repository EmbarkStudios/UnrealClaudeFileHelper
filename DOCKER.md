# Docker Setup for unreal-index

## Prerequisites

- **Docker Desktop for Windows** with WSL 2 backend enabled
- At least **4 GB RAM** allocated to Docker (Settings > Resources > Memory)
- The Windows watcher (`node src\watcher\watcher-client.js`) runs outside the container

## Quick Start

```bash
# Build and start the service
docker compose up -d

# Verify it's running
curl http://localhost:3847/health

# Start the watcher on Windows (separate terminal)
node src\watcher\watcher-client.js
```

Or use the convenience script:

```bash
./start-service.sh --docker
```

## Architecture

```
  Windows Host
  ┌─────────────────────────────────────┐
  │  Watcher (node watcher-client.js)   │
  │      reads P4 workspace files       │
  │      parses AS/C++/assets           │
  │             │                       │
  │             │ POST /internal/ingest  │
  │             ▼                       │
  │  ┌─────────────────────────────┐    │
  │  │   Docker Container          │    │
  │  │   ┌───────────────────┐     │    │
  │  │   │  Node.js Service  │:3847│◄───┼── Claude Code / MCP
  │  │   │  (Express API)    │     │    │
  │  │   │  SQLite + Memory  │     │    │
  │  │   └───────┬───────────┘     │    │
  │  │           │                 │    │
  │  │   ┌───────▼───────────┐     │    │
  │  │   │  Zoekt            │     │    │
  │  │   │  (index + web)    │     │    │
  │  │   └───────────────────┘     │    │
  │  │                             │    │
  │  │  Volumes:                   │    │
  │  │   /data/db      (SQLite)    │    │
  │  │   /data/mirror  (Zoekt src) │    │
  │  │   /data/zoekt-index (shards)│    │
  │  └─────────────────────────────┘    │
  └─────────────────────────────────────┘
```

## Configuration

The container uses `config.docker.json` as the default config. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `service.host` | `0.0.0.0` | Required for Docker port mapping |
| `service.port` | `3847` | API port |
| `data.dbPath` | `/data/db/index.db` | SQLite database path |
| `data.mirrorDir` | `/data/mirror` | Zoekt mirror directory |
| `data.indexDir` | `/data/zoekt-index` | Zoekt index shards |
| `zoekt.parallelism` | `4` | Zoekt indexing threads |
| `projects` | `[]` | Empty — data arrives via `/internal/ingest` |

### Custom config

Mount a custom config file:

```yaml
# docker-compose.override.yml
services:
  unreal-index:
    volumes:
      - ./my-config.json:/app/config.json:ro
```

### Environment variables

- `UNREAL_INDEX_CONFIG` — path to config file (overrides default)
- `NODE_OPTIONS` — Node.js options (default: `--max-old-space-size=3072`)

## Data Persistence

Data is stored in three Docker named volumes:

| Volume | Contents | Purpose |
|--------|----------|---------|
| `unreal-index-db` | `index.db` | SQLite database |
| `unreal-index-mirror` | Source files | Zoekt mirror for grep |
| `unreal-index-zoekt` | Index shards | Zoekt search index |

### Lifecycle

```bash
# Stop container (data preserved)
docker compose down

# Start again (data still there)
docker compose up -d

# DANGER: Remove data volumes
docker compose down -v
```

### Backup

```bash
# Backup database
docker compose exec unreal-index cp /data/db/index.db /data/db/index.db.bak

# Copy database to host
docker compose cp unreal-index:/data/db/index.db ./backup-index.db
```

### Restore

```bash
# Copy database into container
docker compose cp ./backup-index.db unreal-index:/data/db/index.db

# Restart to load
docker compose restart
```

## Memory Configuration

The container is limited to 4 GB RAM:
- **3 GB** — Node.js heap (`--max-old-space-size=3072`)
- **~1 GB** — Zoekt processes, OS overhead, SQLite mmap

For larger codebases, increase both limits in `docker-compose.yml`:

```yaml
services:
  unreal-index:
    mem_limit: 6g
    memswap_limit: 6g
    environment:
      - NODE_OPTIONS=--max-old-space-size=4096
```

Also ensure Docker Desktop has sufficient RAM allocated (Settings > Resources).

## Troubleshooting

### Port conflict

```
Error: listen EADDRINUSE: address already in use :::3847
```

Another process is using port 3847. Stop it or change the port mapping:

```yaml
ports:
  - "3848:3847"  # Use 3848 on host
```

### Container OOM killed

```bash
# Check if container was OOM killed
docker inspect unreal-index | grep -A 5 OOMKilled
```

Increase `mem_limit` in `docker-compose.yml` and Docker Desktop RAM allocation.

### Slow queries after restart

The in-memory index needs to reload from SQLite on startup (~10s for large indexes). Queries during this window may be slow or return empty results. The health check accounts for this with a 30s start period.

### SQLite errors

SQLite runs on a Docker named volume (ext4 filesystem). This avoids the performance issues of bind-mounting from Windows NTFS. If you see locking errors, ensure only one container is running:

```bash
docker compose ps
```

### Viewing logs

```bash
# Follow logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail=100
```

## Development

Use the dev compose override for source mounting with auto-reload:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This mounts `src/` and `public/` as read-only volumes and enables Node.js `--watch` mode. The container rebuilds only when dependencies change.

To rebuild after dependency changes:

```bash
docker compose build
```

## Performance Testing

Run the Docker performance test from the host:

```bash
node test-docker-perf.mjs
```

With a baseline comparison:

```bash
node test-docker-perf.mjs --baseline perf-baseline-wsl.json
```

Long-running stability test (30 minutes):

```bash
node test-docker-perf.mjs --long-run
```

## Docker vs WSL Comparison

| Aspect | WSL (current) | Docker |
|--------|---------------|--------|
| **Setup** | Manual: Node 22, Go, Zoekt build, screen | `docker compose up -d` |
| **Networking** | WSL mirrored mode, screen hacks | Standard port mapping |
| **Persistence** | `~/.unreal-index/` on ext4 | Named volumes (ext4) |
| **Updates** | `git pull && npm install` | `docker compose build && up -d` |
| **Memory** | Shared with WSL | Isolated, configurable limit |
| **Startup** | ~10s (warm) | ~15s (warm, includes container overhead) |
| **SQLite perf** | Native ext4 | Named volume ext4 (equivalent) |
| **Background** | Requires `screen` | Built-in container lifecycle |
| **Portability** | Tied to this machine's WSL setup | Any Docker host |
