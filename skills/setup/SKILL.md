---
name: setup
description: Initialize and configure the embark-claude-index plugin. Opens a web-based setup GUI where all prerequisites and configuration are managed.
---

# embark-claude-index Setup

First-time setup for the Unreal Engine code index plugin.

**CRITICAL SHELL INFO**: Claude Code runs in **Git Bash (MINGW)** on Windows. All commands below use bash syntax. Do NOT use PowerShell (`$env:`, `Get-ChildItem`) or cmd.exe (`dir /s`) syntax.

## When to Use

Trigger this skill when:
- User just installed the plugin and needs to set it up
- User says "setup", "configure", or "initialize" the index
- User wants to reconfigure project paths or re-run setup
- The MCP tools return "service not running" errors and no config exists

## Prerequisites

The only hard prerequisite to launch the dashboard is **Node.js 20.18+**. Everything else (WSL, Docker, environment variables) is installed from within the dashboard GUI.

**You MUST check and auto-install missing prerequisites — do NOT just tell the user to install them.**

### Check Node.js

```bash
node --version 2>/dev/null || echo "NOT_INSTALLED"
```

If Node.js is missing or the version is below 20.18, **install it automatically**:

```bash
powershell.exe -Command "Start-Process powershell -ArgumentList '-Command','winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements' -Verb RunAs" -Wait
```

After installation, verify it succeeded by checking again in a fresh shell:
```bash
"/c/Program Files/nodejs/node.exe" --version
```

If the install succeeded but `node` is not on PATH yet, tell the user to **restart their terminal** so the PATH update takes effect, then re-run this skill.

### Check npm

```bash
npm --version 2>/dev/null || echo "NOT_INSTALLED"
```

npm ships with Node.js. If npm is missing but Node.js was just installed, the user needs to restart their terminal for PATH changes. If npm is still missing after restart, install it:

```bash
"/c/Program Files/nodejs/node.exe" "/c/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" --version
```

## Setup Steps

### Step 1: Clone or update the repo

```bash
if [ -d "$USERPROFILE/.claude/repos/embark-claude-index/.git" ]; then
  cd "$USERPROFILE/.claude/repos/embark-claude-index" && git pull --ff-only && echo "Repo updated"
else
  git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$USERPROFILE/.claude/repos/embark-claude-index" && echo "Repo cloned"
fi
```

### Step 2: Install dependencies

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && npm install --ignore-scripts --omit=dev
```

If `npm` is not found, use the full path:
```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && "/c/Program Files/nodejs/npm" install --ignore-scripts --omit=dev
```

### Step 3: Launch the setup GUI

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && node src/setup-gui.js
```

This opens a web-based dashboard at **http://localhost:3846**.

### Step 4: Tell the user to complete setup in the dashboard

The dashboard handles everything else:
- **Prerequisites panel**: Shows status of WSL, Docker, Node.js, and UNREAL_INDEX_DIR with one-click install buttons for each
- **Workspace management**: Add workspaces, configure project paths, build Docker images, start containers and watchers
- **MCP config**: Provides the config snippet to add to Claude Code settings
- **Auto-start**: Optionally enable dashboard auto-start at logon

Tell the user to follow the prerequisites checklist in the dashboard, then add a workspace. After setup, **restart their terminal and Claude Code** to pick up the environment variable and MCP tools.
