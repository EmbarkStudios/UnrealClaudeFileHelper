# embark-claude-index

MCP server plugin providing fast code navigation for Unreal Engine projects. Indexes AngelScript, C++, Blueprints, and assets.

## Tool Instructions

Always use unreal-index MCP tools instead of Bash commands for searching UE/AS code:

- Use `unreal_find_file` instead of `find` or `ls` to locate source files by name
- Use `unreal_grep` instead of `grep`, `rg`, or `sed -n` to search file contents or find line numbers
- Use `unreal_find_type` instead of grep to locate class/struct/enum definitions
- Use `unreal_find_member` instead of grep to locate function/property definitions
- Use the `Read` tool (not sed/cat/head) to read file contents after finding them

Never fall back to Bash find/grep — these tools are faster, project-aware, and return structured results.
If a search returns no results, check the hints in the response for guidance (wrong project filter, try fuzzy, etc).

## Architecture

- **Docker-only deployment**: Each workspace runs as a Docker container with service + Zoekt + SQLite
- **Multi-workspace**: Multiple P4 workspaces can be indexed independently, each with its own container and port
- **Windows watcher** (`src/watcher/watcher-client.js`): Watches project files, parses them, POSTs to the service container
- **Docker service** (`src/service/index.js`): Express API, SQLite DB, in-memory query index, Zoekt — all inside the container
- **MCP bridge** (`src/bridge/mcp-bridge.js`): Routes MCP tool calls to the correct workspace container based on the `workspace` parameter
- **Setup GUI** (`src/setup-gui.js`): Web-based setup at `http://localhost:3846` — auto-detects UE projects, configures workspaces, manages Docker containers, installs hooks

### Key Files

- `workspaces.json` — Single source of truth for workspace definitions (name, port, shared settings)
- `workspace-configs/<name>.json` — Per-workspace config (projects, paths, service settings)
- `docker-compose.yml` — Generated from `workspaces.json`, one service per workspace

## Development

- `npm run setup` — Open the web-based setup GUI at `http://localhost:3846` (no npm install needed)
- `docker compose up` — Start all workspace containers
- `docker compose up <workspace>` — Start a specific workspace container
- `npm run watcher -- --workspace <name>` — Start the file watcher for a specific workspace
- `npm run bridge` — Start the MCP bridge standalone
- `npm test` — Run tests
