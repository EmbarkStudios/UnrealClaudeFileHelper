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

If Node.js is missing or too old:
```bash
powershell.exe -Command "Start-Process powershell -ArgumentList '-Command','winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements' -Verb RunAs"
```
Tell the user to **restart their terminal** after Node.js installation.

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
