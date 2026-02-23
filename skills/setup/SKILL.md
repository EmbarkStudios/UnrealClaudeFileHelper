---
name: setup
description: Initialize and configure the embark-claude-index plugin. Opens a web-based setup GUI to configure workspaces, build Docker containers, start watchers, and install MCP hooks.
---

# embark-claude-index Setup

First-time setup for the Unreal Engine code index plugin.

**CRITICAL SHELL INFO**: Claude Code runs in **Git Bash (MINGW)** on Windows. All commands below use bash syntax. Do NOT use PowerShell (`$env:`, `Get-ChildItem`) or cmd.exe (`dir /s`) syntax — they will fail.

## When to Use

Trigger this skill when:
- User just installed the plugin and needs to set it up
- User says "setup", "configure", or "initialize" the index
- User wants to reconfigure project paths or re-run setup
- The MCP tools return "service not running" errors and no config exists

## Prerequisites

- **Node.js 20.18+** (22+ recommended) on Windows
- **Docker Desktop** with WSL 2 backend

Verify Docker is available:
```bash
wsl -- bash -c 'docker compose version 2>/dev/null && echo "DOCKER_OK" || echo "DOCKER_MISSING"'
```

If `DOCKER_MISSING`, the user must install Docker Desktop first.

---

## Setup Steps

### Step 1: Clone or update the repo

```bash
if [ -d "$USERPROFILE/.claude/repos/embark-claude-index/.git" ]; then
  cd "$USERPROFILE/.claude/repos/embark-claude-index" && git pull --ff-only && echo "Repo updated"
else
  git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$USERPROFILE/.claude/repos/embark-claude-index" && echo "Repo cloned"
fi
```

### Step 2: Install dependencies on Windows

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && npm install --ignore-scripts --omit=dev
```

**Note:** `--ignore-scripts` skips native compilation of better-sqlite3 which is only needed inside the Docker container.

### Step 3: Set UNREAL_INDEX_DIR environment variable

Set `UNREAL_INDEX_DIR` as a **persistent user-level environment variable** so the MCP bridge can be found across sessions.

```bash
powershell.exe -Command "[Environment]::SetEnvironmentVariable('UNREAL_INDEX_DIR', (Join-Path \$env:USERPROFILE '.claude\repos\embark-claude-index'), 'User')"
```

Verify:
```bash
powershell.exe -Command "[Environment]::GetEnvironmentVariable('UNREAL_INDEX_DIR', 'User')"
```

**IMPORTANT**: Tell the user they must **restart their terminal** for the new environment variable to take effect.

### Step 4: Launch the setup GUI

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && node src/setup-gui.js
```

This opens a web-based setup GUI at **http://localhost:3846** in the default browser. The GUI auto-detects Unreal Engine projects on the system.

### Step 5: Walk through the GUI workflow

Guide the user through the setup GUI:

1. **Add a workspace** — Give it a name (e.g., `discovery`) and assign a port (default: 3847). Each workspace gets its own Docker container.
2. **Configure projects** — Add project paths (Script, Source, Plugins, Content directories). The GUI auto-detects `.uproject` files.
3. **Build Docker image** — Click "Build Image" to build the container image (first build takes 3-5 minutes as it compiles Zoekt from Go source).
4. **Start container** — Click "Start" to launch the workspace container. The GUI shows container status in real-time.
5. **Start watcher** — Click "Start Watcher" to begin indexing project files. First scan may take 10-20 minutes for large codebases.
6. **Install hooks** — Click "Install Hooks" to set up PreToolUse hooks that route Grep/Glob/Bash calls through the index.
7. **Copy MCP config** — The GUI provides the MCP configuration snippet to add to Claude Code settings.

The GUI generates:
- `workspaces.json` — Workspace definitions (name, port, shared settings)
- `workspace-configs/<name>.json` — Per-workspace config (project paths, service settings)
- `docker-compose.yml` — Docker Compose file with one service per workspace

### Step 6: Verify the service is running

After the container starts, verify via health check (replace port with the workspace's assigned port):

```bash
curl -s http://127.0.0.1:3847/health
```

Should show `"status":"ok"`, `"zoekt":{"running":true}`, `"memoryIndex":{"loaded":true}`.

To check index status:
```bash
curl -s http://127.0.0.1:3847/internal/status
```

Should show non-zero counts for indexed file types after the watcher completes.

### Step 7: Restart Claude Code

Tell the user:
- **Restart their terminal AND Claude Code** to pick up the `UNREAL_INDEX_DIR` environment variable and MCP tools
- **Open the setup GUI dashboard** at [http://localhost:3846](http://localhost:3846) to monitor health, watcher status, and query analytics

---

## Troubleshooting

### Docker Issues

- **"docker compose" not found in WSL**: Install Docker Desktop with WSL 2 backend, or install Docker Engine in WSL (`sudo apt install docker.io docker-compose-v2`)
- **Container exits immediately**: Check logs with `docker compose logs <workspace-name>` — usually a config syntax error or port conflict
- **Out of memory**: Increase Docker/WSL memory limit, or reduce memory limit per workspace in the setup GUI
- **First build is slow**: Normal — Go compiles Zoekt from source (3-5 min). Cached on subsequent builds
- **Port already in use**: Stop the conflicting service, or change the workspace port in the setup GUI. To stop all containers: `docker compose down`
- **Health check failing after start**: Container has a 60s start-period for initial index loading. Wait and retry

### Watcher Issues

- **Watcher can't connect**: Ensure the workspace container is running. Check with `docker compose ps`
- **Watcher shows 0 projects**: Verify project paths are configured in the setup GUI. The watcher reads its project list from the service's config endpoint
- **Files not being indexed**: Check that file extensions match the configured project language (`.as` for AngelScript, `.h/.cpp` for C++, `.uasset/.umap` for content)

### General Issues

- **MCP bridge not found / "Failed to reconnect"**: Ensure `UNREAL_INDEX_DIR` is set: `powershell.exe -Command "[Environment]::GetEnvironmentVariable('UNREAL_INDEX_DIR', 'User')"`. If empty, re-run Step 3. Restart terminal.
- **Plugin update broke MCP bridge**: `cd "$USERPROFILE/.claude/repos/embark-claude-index" && git pull --ff-only && npm install --ignore-scripts --omit=dev`
- **Multiple workspaces**: Each workspace runs on a different port. The MCP bridge routes queries to the correct workspace automatically based on the `workspace` parameter.
