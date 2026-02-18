---
name: setup
description: Initialize and configure the embark-claude-index plugin. Docker-first deployment — builds and starts the service container, runs setup wizard, starts the file watcher. Fallback to manual WSL setup if Docker is not available.
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

## Prerequisites Check

Before starting, determine which setup path to follow:

```bash
wsl -- bash -c 'docker compose version 2>/dev/null && echo "DOCKER_OK" || echo "DOCKER_MISSING"'
```

- If output contains `DOCKER_OK` → follow **Docker Setup** (recommended)
- If `DOCKER_MISSING` → follow **Manual WSL Setup** (fallback)

---

## Docker Setup (Recommended)

Docker bundles Node.js, Zoekt, and all dependencies in a single container. No need to install Go, compile Zoekt, or manage systemd services.

### Step 1: Clone or update the repo

```bash
if [ -d "$USERPROFILE/.claude/repos/embark-claude-index/.git" ]; then
  cd "$USERPROFILE/.claude/repos/embark-claude-index" && git pull --ff-only && echo "Repo updated"
else
  git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$USERPROFILE/.claude/repos/embark-claude-index" && echo "Repo cloned"
fi
```

Install dependencies on Windows (for the MCP bridge and watcher):

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && npm install --ignore-scripts --omit=dev
```

**Note:** `--ignore-scripts` skips native compilation of better-sqlite3 which is only needed inside the Docker container.

### Step 2: Set UNREAL_INDEX_DIR environment variable

Set `UNREAL_INDEX_DIR` as a **persistent user-level environment variable** so the MCP bridge can be found across sessions.

```bash
powershell.exe -Command "[Environment]::SetEnvironmentVariable('UNREAL_INDEX_DIR', (Join-Path \$env:USERPROFILE '.claude\repos\embark-claude-index'), 'User')"
```

Verify:
```bash
powershell.exe -Command "[Environment]::GetEnvironmentVariable('UNREAL_INDEX_DIR', 'User')"
```

**IMPORTANT**: Tell the user they must **restart their terminal** for the new environment variable to take effect.

### Step 3: Run the setup wizard

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && node src/setup.js
```

The wizard will:
- Ask for project root path (detects `.uproject` files)
- Detect directories to index (Script, Source, Plugins, Content, Config)
- Ask deployment mode — **select Docker**
- Generate `config.json` with Docker-appropriate settings (`0.0.0.0` host, `/data/*` paths)

**Note:** The wizard accepts Windows paths (e.g. `D:\p4\games\Games\MyProject`) and converts them automatically.

### Step 4: Build and start the Docker container

The first build takes 3-5 minutes (compiles Zoekt from Go source). Subsequent starts are instant.

```bash
wsl -- bash -c 'cd "$(wslpath "$(cmd.exe /C echo %USERPROFILE% 2>/dev/null | tr -d "\r")")/.claude/repos/embark-claude-index" && docker compose up -d'
```

If the above path detection is unreliable, use the direct path:
```bash
wsl -- bash -c 'cd /mnt/c/Users/<USERNAME>/.claude/repos/embark-claude-index && docker compose up -d'
```
Replace `<USERNAME>` with the actual Windows username.

Wait for the service to start, then verify:
```bash
wsl -- bash -c 'sleep 5 && curl -s http://127.0.0.1:3847/health'
```

Should show `"status":"ok"`, `"zoekt":{"running":true}`, `"memoryIndex":{"loaded":true}`.

To follow logs:
```bash
wsl -- bash -c 'docker compose -f /mnt/c/Users/<USERNAME>/.claude/repos/embark-claude-index/docker-compose.yml logs -f'
```

### Step 5: Start the file watcher

The watcher runs on Windows to watch project files and push them to the container:

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && node src/watcher/watcher-client.js
```

The watcher runs in the foreground and shows progress. Tell the user they can:
- Let it run in this terminal (first scan may take 10-20 minutes for large codebases)
- Or open a separate terminal to run it

### Step 6: Install PreToolUse hooks (optional but recommended)

The hooks intercept Grep, Glob, and Bash tool calls and route them through the index for faster results. The setup wizard (Step 3) should have already prompted for this. If skipped:

```bash
node "$USERPROFILE/.claude/repos/embark-claude-index/src/hooks/install.js" "<PROJECT_DIR>"
```

Replace `<PROJECT_DIR>` with the project working directory (e.g., `D:\p4\games\Games\MyProject\Script`).

Tell the user they need to **restart Claude Code** after installing hooks.

### Step 7: Verify

After the watcher outputs progress, verify the index has data:

```bash
wsl -- bash -c 'curl -s http://127.0.0.1:3847/internal/status'
```

Should show non-zero counts for indexed file types.

Tell the user:
- **Restart their terminal AND Claude Code** to pick up the `UNREAL_INDEX_DIR` environment variable and MCP tools
- **Open the dashboard** at [http://localhost:3847](http://localhost:3847) to monitor health, watcher status, and query analytics

---

## Manual WSL Setup (Fallback)

Use this path if Docker is not available. This installs Node.js, Go, and Zoekt manually in WSL.

### Step 1: Clone the repo into WSL

```bash
wsl -- bash -c 'mkdir -p "$HOME/.claude/repos" && if [ -d "$HOME/.claude/repos/embark-claude-index/.git" ]; then cd "$HOME/.claude/repos/embark-claude-index" && git pull --ff-only && echo "Repo updated"; else git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$HOME/.claude/repos/embark-claude-index" && echo "Repo cloned"; fi'
```

### Step 2: Install Node.js dependencies in WSL

```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && node --version && npm install --production'
```

**If Node.js is not found or too old** (need 20.18+):
```bash
wsl -- bash -c 'mkdir -p "$HOME/local/node22" && curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz | tar -xJ -C "$HOME/local/node22" --strip-components=1 && echo "Node.js installed: $($HOME/local/node22/bin/node --version)"'
```
Then retry the npm install command above.

**If better-sqlite3 fails to compile** (missing build tools):
```bash
wsl -- bash -c 'sudo apt install -y build-essential python3'
```
Then retry npm install.

### Step 3: Clone or update Windows-side repo for the MCP bridge

```bash
if [ -d "$USERPROFILE/.claude/repos/embark-claude-index/.git" ]; then
  cd "$USERPROFILE/.claude/repos/embark-claude-index" && git pull --ff-only && echo "Windows repo updated"
else
  git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$USERPROFILE/.claude/repos/embark-claude-index" && echo "Windows repo cloned"
fi
```

Install dependencies on Windows:
```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && npm install --ignore-scripts --omit=dev
```

### Step 4: Set UNREAL_INDEX_DIR environment variable

```bash
powershell.exe -Command "[Environment]::SetEnvironmentVariable('UNREAL_INDEX_DIR', (Join-Path \$env:USERPROFILE '.claude\repos\embark-claude-index'), 'User')"
```

Verify:
```bash
powershell.exe -Command "[Environment]::GetEnvironmentVariable('UNREAL_INDEX_DIR', 'User')"
```

**IMPORTANT**: Tell the user they must **restart their terminal** for the new environment variable to take effect.

### Step 5: Run the interactive setup wizard in WSL

```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && node src/setup.js'
```

The wizard will ask for project paths, engine paths, and generate `config.json`. Select **Manual WSL** when asked about deployment mode.

### Step 6: Install Zoekt in WSL (full-text code search)

```bash
wsl -- bash -c 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"; if command -v zoekt-index >/dev/null 2>&1; then echo "Zoekt already installed"; elif command -v go >/dev/null 2>&1; then echo "Installing Zoekt..." && go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest && go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest && echo "Zoekt installed"; else echo "Go not found - Zoekt (optional) requires Go: https://go.dev/dl/"; fi'
```

If Go is missing: Zoekt is optional but recommended. Without it, `unreal_grep` will be unavailable.

### Step 7: Start the indexing service in WSL

First check if it's already running:
```bash
wsl -- bash -c 'curl -s http://127.0.0.1:3847/health 2>/dev/null && echo "Service already running" || echo "Service not running"'
```

If not running:
```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && screen -dmS unreal-index bash -c "node src/service/index.js 2>&1 | tee /tmp/unreal-index.log"'
```

**If screen is not installed:**
```bash
wsl -- bash -c 'sudo apt install -y screen'
```

Verify:
```bash
wsl -- bash -c 'sleep 3 && curl -s http://127.0.0.1:3847/health'
```

### Step 8: Start the file watcher

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && node src/watcher/watcher-client.js
```

### Step 9: Install PreToolUse hooks (optional but recommended)

```bash
node "$USERPROFILE/.claude/repos/embark-claude-index/src/hooks/install.js" "<PROJECT_DIR>"
```

Replace `<PROJECT_DIR>` with the project path. Tell user to **restart Claude Code** after.

### Step 10: Verify

```bash
wsl -- bash -c 'curl -s http://127.0.0.1:3847/internal/status'
```

Tell the user:
- **Restart their terminal AND Claude Code** to pick up the `UNREAL_INDEX_DIR` environment variable and MCP tools
- **Open the dashboard** at [http://localhost:3847](http://localhost:3847) to monitor service health

---

## Troubleshooting

### Docker Issues

- **"docker compose" not found in WSL**: Install Docker Engine in WSL (`sudo apt install docker.io docker-compose-v2`) or install Docker Desktop with WSL 2 backend
- **Container exits immediately**: `wsl -- bash -c 'docker logs unreal-index'` — usually config.json syntax error or missing bind mount
- **Out of memory**: Increase Docker/WSL memory limit, or reduce `zoekt.parallelism` to 2 in config.json
- **First build is slow**: Normal — Go compiles Zoekt from source (3-5 min). Cached on subsequent builds
- **Port 3847 in use**: Stop conflicting service. If previous Docker container: `wsl -- bash -c 'docker compose down'`
- **Health check failing after start**: Container has a 60s start-period for initial index loading. Wait and retry

### WSL Issues

- **"wsl is not recognized"**: WSL is not installed. User needs: https://learn.microsoft.com/en-us/windows/wsl/install
- **Node.js too old in WSL**: Need 20.18+. Install Node 22 with the command in Manual Step 2
- **Port 3847 in use**: `wsl -- bash -c 'kill $(lsof -ti:3847)'` then restart service
- **WSL networking / localhost not working**: Check `cat "$USERPROFILE/.wslconfig"` contains `[wsl2]` and `networkingMode=mirrored`
- **Screen not installed**: `wsl -- bash -c 'sudo apt install -y screen'`
- **better-sqlite3 compile error**: `wsl -- bash -c 'sudo apt install -y build-essential python3'`
- **npm install fails with EACCES**: Don't run npm as root. Fix: `wsl -- bash -c 'sudo chown -R $(whoami) "$HOME/.claude"'`

### General Issues

- **MCP bridge not found / "Failed to reconnect"**: Ensure `UNREAL_INDEX_DIR` is set: `powershell.exe -Command "[Environment]::GetEnvironmentVariable('UNREAL_INDEX_DIR', 'User')"`. If empty, re-run the env var step. Restart terminal.
- **Plugin update broke MCP bridge**: `cd "$USERPROFILE/.claude/repos/embark-claude-index" && git pull --ff-only && npm install --ignore-scripts --omit=dev`
