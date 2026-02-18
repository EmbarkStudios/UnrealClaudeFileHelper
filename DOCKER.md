# Docker Deployment

Run the unreal-index service in a Docker container instead of manually setting up WSL, Node 22, Go, and Zoekt.

## Prerequisites

- Docker Desktop with WSL 2 backend (Windows) or Docker Engine (Linux)
- At least 6 GB of RAM allocated to Docker

## Quick Start

```bash
# Build and start
docker compose up -d

# Check status
docker compose logs -f
curl http://localhost:3847/health

# Stop
docker compose stop
```

The service starts with an empty index. Point the Windows watcher (`npm run watcher`) at your projects — it POSTs to `http://localhost:3847/internal/ingest` which works identically whether the service runs in Docker or WSL.

## Architecture

```
Windows Host                          Docker Container (Linux)
┌──────────────────┐                 ┌──────────────────────────┐
│ Watcher           │  HTTP POST     │  tini (PID 1)            │
│ (watcher-client)  │───────────────►│  └─ node service/index.js│
│                   │  :3847         │      ├─ Express API :3847 │
│ MCP Bridge        │  HTTP GET      │      ├─ SQLite (WAL)     │
│ (mcp-bridge)      │───────────────►│      ├─ Memory Index     │
│                   │  :3847         │      └─ zoekt-webserver   │
└──────────────────┘                 │          └─ :6070 (int)   │
                                     │                           │
                                     │  Volumes:                 │
                                     │  /data/db     (SQLite)    │
                                     │  /data/mirror (Zoekt src) │
                                     │  /data/zoekt-index (shards│)
                                     └──────────────────────────┘
```

The container bundles Node.js 22, Zoekt (built from source), and the service code. Data is persisted in three named Docker volumes.

## Configuration

The container ships with `config.docker.json` as the default config. To customize:

```bash
# Copy the default config and edit it
cp config.docker.json config.json
# Edit config.json as needed, then uncomment the bind mount in docker-compose.yml:
#   - ./config.json:/app/config.json:ro
docker compose up -d
```

Key config values:
- `service.host`: Must be `"0.0.0.0"` for Docker port mapping (default in docker config)
- `service.port`: `3847` (default)
- `data.dbPath`: `/data/db/index.db` (mapped to volume)
- `data.mirrorDir`: `/data/mirror` (mapped to volume)
- `data.indexDir`: `/data/zoekt-index` (mapped to volume)
- `zoekt.parallelism`: `4` (reduce to `2` if memory is tight)

## Development

Use the dev overlay for live reload during development:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This mounts `./src` and `./public` read-only into the container and uses `node --watch` for automatic restarts. Port 6070 is also exposed for direct Zoekt debugging.

## Volume Management

```bash
# View volume sizes
docker system df -v | grep unreal-index

# Backup the database
docker compose cp unreal-index:/data/db/index.db ./backup-index.db

# Reset all data (stops container, removes volumes)
docker compose down -v

# Reset just the Zoekt index (will rebuild on next start)
docker volume rm unreal-index-zoekt
```

## Memory Tuning

Default limits: 5 GB RAM, 7 GB total (with 2 GB swap).

| Consumer | Typical Usage |
|----------|--------------|
| Node.js V8 heap | up to 3 GB |
| SQLite page cache | ~256 MB |
| Zoekt webserver | ~150-200 MB |
| Zoekt indexer (transient) | ~200-500 MB |

If you're running out of memory:
1. Reduce `zoekt.parallelism` to `2` in your config
2. Increase `mem_limit` in `docker-compose.yml`

Monitor with: `docker stats unreal-index`

## Troubleshooting

**Container exits immediately**
```bash
docker compose logs unreal-index
```
Common causes: config.json syntax error, port 3847 already in use.

**Health check failing**
```bash
# Check if the service is still starting up (start-period is 60s)
docker inspect unreal-index --format='{{.State.Health.Status}}'

# Check service logs
docker compose logs --tail=50 unreal-index
```

**Zoekt not available**
```bash
# Verify Zoekt binaries are present
docker compose exec unreal-index which zoekt-index zoekt-webserver
```

**Database corruption after OOM kill**
SQLite WAL mode recovers automatically on restart. If issues persist:
```bash
docker compose down
docker volume rm unreal-index-db
docker compose up -d
# Re-run watcher to repopulate
```

## Migration from WSL

If you're currently running the service in WSL and want to switch to Docker:

1. Stop the WSL service: `systemctl --user stop unreal-index` (or `kill $(lsof -ti:3847)`)
2. Start Docker: `docker compose up -d`
3. The watcher doesn't need any changes — it already POSTs to `localhost:3847`
4. Data will be re-indexed from scratch (the watcher handles this on startup)

To preserve existing data, copy from WSL before starting Docker:
```bash
# Copy database
docker compose up -d  # create volumes first
docker compose cp ~/.unreal-index/index.db unreal-index:/data/db/index.db
docker compose restart
```
