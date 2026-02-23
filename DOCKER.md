# Docker Deployment

Each workspace runs as its own Docker container with a dedicated port, SQLite database, and Zoekt index.

## Prerequisites

- Docker Desktop with WSL 2 backend (Windows) or Docker Engine (Linux)
- At least 6 GB of RAM allocated to Docker per workspace

## Quick Start

The easiest way to get started is the setup GUI:

```bash
npm run setup
# Opens http://localhost:3846
```

The GUI walks you through creating workspaces, building the Docker image, and starting containers.

For manual control:

```bash
# Build and start all workspaces
docker compose up -d

# Check status
docker compose ps
docker compose logs -f <workspace-name>
curl http://localhost:3847/health

# Stop all workspaces
docker compose stop
```

## Architecture

```
Windows Host                          Docker Containers (one per workspace)
┌──────────────────┐
│ Watcher(s)        │                 ┌──────────────────────────┐
│ (watcher-client)  │  HTTP POST     │  discovery (:3847)        │
│ --workspace disc  │───────────────►│  node service/index.js    │
│ --workspace edit  │  :3847/:3848   │  Express + SQLite + Zoekt │
│                   │                 │  Volumes:                 │
│ MCP Bridge        │  HTTP GET      │    discovery-db            │
│ (mcp-bridge)      │───────────────►│    discovery-mirror        │
│                   │  routed by     │    discovery-zoekt          │
│                   │  workspace     └──────────────────────────┘
└──────────────────┘
                                      ┌──────────────────────────┐
                                      │  editormain (:3848)       │
                                      │  node service/index.js    │
                                      │  Express + SQLite + Zoekt │
                                      │  Volumes:                 │
                                      │    pioneer-db              │
                                      │    pioneer-mirror          │
                                      │    pioneer-zoekt            │
                                      └──────────────────────────┘
```

Each container bundles Node.js 22, Zoekt (built from source), and the service code. Data is persisted in workspace-prefixed Docker volumes.

## Configuration

Configuration is managed through the setup GUI (`npm run setup` at `http://localhost:3846`), which generates:

- **`workspaces.json`** — Workspace definitions (name, port, shared settings)
- **`workspace-configs/<name>.json`** — Per-workspace config (project paths, service settings)
- **`docker-compose.yml`** — Generated Compose file with one service per workspace

To customize manually:

1. Copy `workspaces.example.json` to `workspaces.json` and edit
2. Create `workspace-configs/<name>.json` for each workspace
3. Run `npm run setup` to regenerate `docker-compose.yml`

Key per-workspace config values:
- `service.host`: Must be `"0.0.0.0"` for Docker port mapping
- `service.port`: `3847` inside the container (mapped to workspace-specific host port)
- `zoekt.parallelism`: `4` (reduce to `2` if memory is tight)

## Volume Management

Volumes are prefixed with the workspace name:

```bash
# View volume sizes
docker system df -v | grep -E "(discovery|editormain)"

# Backup a workspace database
docker compose cp <workspace-name>:/data/db/index.db ./backup-index.db

# Reset all data for all workspaces (stops containers, removes volumes)
docker compose down -v

# Reset just Zoekt index for a workspace (rebuilds on next start)
docker volume rm <workspace-name>-zoekt
```

## Memory Tuning

Default limits per workspace: configurable via the setup GUI (default 8 GB RAM, 10 GB with swap).

| Consumer | Typical Usage |
|----------|--------------|
| Node.js V8 heap | up to 3 GB |
| SQLite page cache | ~256 MB |
| Zoekt webserver | ~150-200 MB |
| Zoekt indexer (transient) | ~200-500 MB |

If you're running out of memory:
1. Reduce `zoekt.parallelism` to `2` in the workspace config
2. Adjust memory limits in the setup GUI or directly in `docker-compose.yml`

Monitor with: `docker stats`

## Development

Use the dev overlay for live reload during development:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up <workspace-name>
```

This mounts `./src` and `./public` read-only into the container and uses `node --watch` for automatic restarts. Port 6070 is also exposed for direct Zoekt debugging.

**Note:** The service name in `docker-compose.dev.yml` must match the workspace name in your generated `docker-compose.yml`. See `docker-compose.dev.yml` for details.

## Troubleshooting

**Container exits immediately**
```bash
docker compose logs <workspace-name>
```
Common causes: config syntax error, port already in use.

**Health check failing**
```bash
# Check if the service is still starting up (start-period is 60s)
docker inspect unreal-index-<workspace-name> --format='{{.State.Health.Status}}'

# Check service logs
docker compose logs --tail=50 <workspace-name>
```

**Zoekt not available**
```bash
docker compose exec <workspace-name> which zoekt-index zoekt-webserver
```

**Database corruption after OOM kill**
SQLite WAL mode recovers automatically on restart. If issues persist:
```bash
docker compose down
docker volume rm <workspace-name>-db
docker compose up -d
# Re-run watcher to repopulate
```
