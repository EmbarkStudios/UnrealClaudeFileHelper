---
name: setup
description: Initialize and configure the embark-claude-index plugin. Clones repo into WSL, installs dependencies, runs the setup wizard, installs Zoekt, and starts the indexing service. Run this after first installing the plugin.
---

# embark-claude-index Setup

First-time setup for the Unreal Engine code index plugin.

**CRITICAL SHELL INFO**: Claude Code runs in **Git Bash (MINGW)** on Windows. All commands below use bash syntax. Do NOT use PowerShell (`$env:`, `Get-ChildItem`) or cmd.exe (`dir /s`) syntax — they will fail.

**IMPORTANT**: This service runs entirely in WSL. Use `wsl -- bash -c '...'` for all service-side operations. Use single quotes for the bash -c argument to prevent variable expansion by Git Bash.

## When to Use

Trigger this skill when:
- User just installed the plugin and needs to set it up
- User says "setup", "configure", or "initialize" the index
- User wants to reconfigure project paths or re-run setup
- The MCP tools return "service not running" errors and no config exists

## Setup Steps

Execute these steps sequentially. Each step depends on the previous one succeeding.

### Step 1: Clone the repo into WSL

Use git clone directly in WSL. This is the simplest and most reliable approach.

```bash
wsl -- bash -c 'mkdir -p "$HOME/.claude/repos" && if [ -d "$HOME/.claude/repos/embark-claude-index/.git" ]; then cd "$HOME/.claude/repos/embark-claude-index" && git pull --ff-only && echo "Repo updated"; else git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$HOME/.claude/repos/embark-claude-index" && echo "Repo cloned"; fi'
```

If this succeeds, move to Step 2. If git clone fails (network issues), ask the user to check their internet connection.

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

### Step 3: Run the interactive setup wizard in WSL

```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && node src/setup.js'
```

The wizard will interactively ask the user for:
- Project root path (detects `.uproject` files)
- Engine source paths
- Content/asset indexing preferences
- It generates `config.json`

**Note:** The wizard accepts Windows paths (e.g. `C:\Projects\MyGame`) and converts them automatically.

### Step 4: Install Zoekt in WSL (full-text code search)

Zoekt provides fast regex search across the entire codebase. It requires Go.

```bash
wsl -- bash -c 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"; if command -v zoekt-index >/dev/null 2>&1; then echo "Zoekt already installed"; elif command -v go >/dev/null 2>&1; then echo "Installing Zoekt..." && go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest && go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest && echo "Zoekt installed"; else echo "Go not found - Zoekt (optional) requires Go: https://go.dev/dl/"; fi'
```

If Go is missing, tell the user: Zoekt is optional but recommended. Without it, `unreal_grep` will be unavailable. They can install Go later and re-run this step.

### Step 5: Start the indexing service in WSL

First check if it's already running:
```bash
wsl -- bash -c 'curl -s http://127.0.0.1:3847/health 2>/dev/null && echo "Service already running" || echo "Service not running"'
```

If not running, start it:
```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && screen -dmS unreal-index bash -c "node src/service/index.js 2>&1 | tee /tmp/unreal-index.log"'
```

**If screen is not installed:**
```bash
wsl -- bash -c 'sudo apt install -y screen'
```
Then retry the start command.

Wait a few seconds, then verify:
```bash
wsl -- bash -c 'sleep 3 && curl -s http://127.0.0.1:3847/health'
```

If the health check fails, check the log:
```bash
wsl -- bash -c 'tail -20 /tmp/unreal-index.log'
```

### Step 6: Start the file watcher

The watcher runs on the Windows side to watch project files. Find the repo path on Windows and start it:

```bash
"$HOME/.claude/repos/embark-claude-index/src/watcher/watcher-client.js"
```

Actually, the WSL repo is NOT directly accessible from Windows Git Bash as a Windows path. The watcher needs to run from a Windows-accessible copy. Check if a Windows copy exists:

```bash
ls "$USERPROFILE/.claude/repos/embark-claude-index/package.json" 2>/dev/null && echo "Windows repo exists" || echo "No Windows repo"
```

If no Windows copy, clone one:
```bash
git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$USERPROFILE/.claude/repos/embark-claude-index"
```

Then install dependencies and start the watcher:
```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && npm install --production && node src/watcher/watcher-client.js
```

Note: The watcher runs in the foreground and will block the terminal. Tell the user they can:
- Let it run in this terminal (it shows progress as files are indexed)
- Or open a separate terminal to run it

### Step 7: Verify

After the watcher outputs "initial scan complete" (may take a few minutes on first run), verify the index has data:

```bash
wsl -- bash -c 'curl -s http://127.0.0.1:3847/internal/status'
```

This should show non-zero counts for indexed files.

Tell the user:
- **Restart Claude Code** to pick up the MCP tools. After restart, all `unreal_*` tools will be available.
- **Open the dashboard** at [http://localhost:3847](http://localhost:3847) to monitor service health, watcher status, Zoekt, query analytics, and MCP tool usage. The dashboard shows the status of all components and has controls to start/restart services.

## Troubleshooting

Common errors and fixes (all commands use bash syntax for Git Bash):

- **"wsl is not recognized"**: WSL is not installed. User needs: https://learn.microsoft.com/en-us/windows/wsl/install
- **Node.js too old in WSL**: Need 20.18+. Install Node 22 with the command in Step 2.
- **Port 3847 in use**: `wsl -- bash -c 'kill $(lsof -ti:3847)'` then restart service
- **WSL networking / localhost not working**: Check `cat "$USERPROFILE/.wslconfig"` contains `[wsl2]` and `networkingMode=mirrored`
- **Screen not installed**: `wsl -- bash -c 'sudo apt install -y screen'`
- **better-sqlite3 compile error**: `wsl -- bash -c 'sudo apt install -y build-essential python3'`
- **npm install fails with EACCES**: Don't run npm as root. Fix permissions: `wsl -- bash -c 'sudo chown -R $(whoami) "$HOME/.claude"'`
