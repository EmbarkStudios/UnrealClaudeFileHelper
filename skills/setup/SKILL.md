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
- **Docker Engine** in WSL 2 (not Docker Desktop — no license needed)
- **WSL 2** installed

### Auto-install missing prerequisites

The agent should **automatically fix** missing prerequisites rather than just reporting them. Follow these steps in order:

#### If WSL is missing:
```bash
wsl --status > /dev/null 2>&1 || powershell.exe -Command "Start-Process wsl -ArgumentList '--install' -Verb RunAs -Wait"
```
Tell the user a **reboot is required** after WSL installation, then re-run `/embark-claude-index:setup`.

#### If Docker is missing in WSL:
Check if Docker is available:
```bash
wsl -- bash -c 'docker compose version 2>/dev/null && echo "DOCKER_OK" || echo "DOCKER_MISSING"'
```

If `DOCKER_MISSING`, install Docker Engine directly in WSL (no Docker Desktop needed):
```bash
wsl -- bash -c 'sudo apt-get update && sudo apt-get install -y ca-certificates curl && sudo install -m 0755 -d /etc/apt/keyrings && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null && sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
```

After installation, start the Docker daemon and add the user to the docker group:
```bash
wsl -- bash -c 'sudo usermod -aG docker $USER && sudo service docker start'
```

**Note:** The `usermod` change requires a new WSL session. Run:
```bash
wsl --shutdown
```
Then re-run the setup. The agent should verify docker works after restart:
```bash
wsl -- bash -c 'docker run --rm hello-world 2>/dev/null && echo "DOCKER_OK" || (sudo service docker start && docker run --rm hello-world 2>/dev/null && echo "DOCKER_OK" || echo "DOCKER_FAILED")'
```

#### If Docker daemon is not running (docker installed but commands fail):
```bash
wsl -- bash -c 'sudo service docker start'
```

#### If Node.js is missing or too old:
```bash
powershell.exe -Command "winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements"
```
Tell the user to **restart their terminal** after Node.js installation.

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

- **"docker compose" not found in WSL**: Install Docker Engine in WSL — re-run `/embark-claude-index:setup` and it will install automatically
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
