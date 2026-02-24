#!/usr/bin/env node

// Standalone installer for unreal-index PreToolUse hooks.
// Deploys the proxy binary (Go or Node.js fallback) to a project's .claude/hooks/,
// updates .claude/settings.json with hook config, and adds search instructions to CLAUDE.local.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Platform detection ───────────────────────────────────────

const isWSL = process.platform === 'linux' && (() => {
  try { return readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft'); } catch { return false; }
})();

/** Convert a Windows path (D:\foo\bar) to WSL path (/mnt/d/foo/bar) when running in WSL. */
function toNativePath(p) {
  if (isWSL && /^[A-Za-z]:[\\\/]/.test(p)) {
    const drive = p[0].toLowerCase();
    return `/mnt/${drive}${p.slice(2).replace(/\\/g, '/')}`;
  }
  return p;
}

/** Ensure a path uses Windows backslash format for use in settings.json. */
function toWindowsPath(p) {
  if (isWSL && p.startsWith('/mnt/')) {
    const match = p.match(/^\/mnt\/([a-z])(\/.*)/);
    if (match) return `${match[1].toUpperCase()}:${match[2].replace(/\//g, '\\')}`;
  }
  // On Windows, normalize forward slashes to backslashes
  if (process.platform === 'win32') {
    return p.replace(/\//g, '\\');
  }
  return p;
}

/** Normalize a path for prefix matching (matches proxy normalization). */
function normalizePath(p) {
  let s = p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  // Git Bash: /d/path → d:/path
  if (s.length >= 3 && s[0] === '/' && s[2] === '/' && s[1] >= 'a' && s[1] <= 'z') {
    s = s[1] + ':' + s.slice(2);
  }
  return s;
}

// ── Main install function ────────────────────────────────────

export async function installHooks(projectDir, { silent = false, tryGo = true } = {}) {
  // Convert to native path for filesystem operations
  const nativeDir = toNativePath(projectDir);
  const claudeDir = join(nativeDir, '.claude');
  const hooksDir = join(claudeDir, 'hooks');
  const settingsPath = join(claudeDir, 'settings.json');
  const claudeLocalMdPath = join(claudeDir, 'CLAUDE.local.md');

  // The command path in settings.json must use the original (Windows) path format
  const winProjectDir = /^[A-Za-z]:[\\\/]/.test(projectDir) ? projectDir : toWindowsPath(nativeDir);
  const winHooksDir = join(winProjectDir, '.claude', 'hooks').replace(/\//g, '\\');

  mkdirSync(hooksDir, { recursive: true });

  // ── Compile or copy proxy ──────────────────────────────────

  let proxyCommand;
  let compiled = false;
  const goSource = join(__dirname, 'unreal-index-proxy.go');

  if (tryGo) {
    try {
      execSync('go version', { stdio: 'pipe', timeout: 5000 });

      const targetExe = join(hooksDir, 'unreal-index-proxy.exe');
      // Cross-compile for Windows when running from WSL
      const envPrefix = isWSL ? 'GOOS=windows GOARCH=amd64 ' : '';
      execSync(`${envPrefix}go build -o "${targetExe}" "${goSource}"`, {
        stdio: 'pipe',
        timeout: 60000,
        cwd: __dirname,
      });
      compiled = true;
      proxyCommand = join(winHooksDir, 'unreal-index-proxy.exe');
      if (!silent) console.log('  Compiled Go proxy binary.');
    } catch (err) {
      if (!silent) console.log(`  Go compilation skipped: ${err.message?.split('\n')[0] || 'not available'}`);
    }
  }

  if (!compiled) {
    // Fall back to Node.js version
    const mjsSource = join(__dirname, 'unreal-index-proxy.mjs');
    const mjsDest = join(hooksDir, 'unreal-index-proxy.mjs');
    copyFileSync(mjsSource, mjsDest);
    proxyCommand = `node "${join(winHooksDir, 'unreal-index-proxy.mjs')}"`;
    if (!silent) console.log('  Installed Node.js proxy (Go not available).');
  }

  // ── Write indexed paths companion config ────────────────────

  const workspacesPath = join(__dirname, '..', '..', 'workspaces.json');
  const legacyConfigPath = join(__dirname, '..', '..', 'config.json');

  let owningWorkspace = null;
  let owningPort = null;
  let wsConfig = null;

  if (existsSync(workspacesPath)) {
    // Multi-workspace mode: read workspaces.json + per-workspace configs
    try {
      wsConfig = JSON.parse(readFileSync(workspacesPath, 'utf-8'));
      const allPrefixes = [];
      const workspaces = [];
      const normalizedProjectDir = normalizePath(projectDir);

      // Build workspace list and detect which workspace owns the project directory
      let bestMatchLen = -1;
      for (const [name, ws] of Object.entries(wsConfig.workspaces || {})) {
        const wsConfigPath = join(__dirname, '..', '..', 'workspace-configs', `${name}.json`);
        let prefixes = [];
        if (existsSync(wsConfigPath)) {
          try {
            const cfg = JSON.parse(readFileSync(wsConfigPath, 'utf-8'));
            prefixes = (cfg.projects || []).flatMap(p => p.paths || []);
          } catch {}
        }
        allPrefixes.push(...prefixes);
        workspaces.push({ port: ws.port, prefixes });

        // Check if this workspace owns the project directory (longest overlap wins)
        for (const prefix of prefixes) {
          const normalizedPrefix = normalizePath(prefix);
          if (normalizedProjectDir.startsWith(normalizedPrefix) || normalizedPrefix.startsWith(normalizedProjectDir)) {
            const matchLen = Math.min(normalizedProjectDir.length, normalizedPrefix.length);
            if (matchLen > bestMatchLen) {
              bestMatchLen = matchLen;
              owningWorkspace = name;
              owningPort = ws.port;
            }
          }
        }
      }

      // Fall back to defaultWorkspace from workspaces.json, then first workspace
      if (!owningWorkspace) {
        const defaultWs = wsConfig.defaultWorkspace;
        if (defaultWs && wsConfig.workspaces[defaultWs]) {
          owningWorkspace = defaultWs;
          owningPort = wsConfig.workspaces[defaultWs].port;
        } else {
          const first = Object.entries(wsConfig.workspaces)[0];
          if (first) {
            owningWorkspace = first[0];
            owningPort = first[1].port;
          }
        }
      }

      const pathsConfig = {
        indexedPrefixes: allPrefixes,
        workspaces,
        ...(owningPort && { defaultPort: owningPort }),
        ...(owningWorkspace && { defaultWorkspace: owningWorkspace }),
      };
      writeFileSync(
        join(hooksDir, 'unreal-index-paths.json'),
        JSON.stringify(pathsConfig, null, 2) + '\n'
      );
      if (!silent) console.log(`  Wrote indexed paths config (${allPrefixes.length} paths, ${workspaces.length} workspaces, default: ${owningWorkspace}@${owningPort}).`);
    } catch (err) {
      if (!silent) console.log(`  Warning: could not write indexed paths config: ${err.message}`);
    }
  } else if (existsSync(legacyConfigPath)) {
    // Legacy single-config mode
    try {
      const config = JSON.parse(readFileSync(legacyConfigPath, 'utf-8'));
      const indexedPrefixes = (config.projects || []).flatMap(p => p.paths || []);
      const pathsConfig = { indexedPrefixes };
      writeFileSync(
        join(hooksDir, 'unreal-index-paths.json'),
        JSON.stringify(pathsConfig, null, 2) + '\n'
      );
      if (!silent) console.log(`  Wrote indexed paths config (${indexedPrefixes.length} paths).`);
    } catch (err) {
      if (!silent) console.log(`  Warning: could not write indexed paths config: ${err.message}`);
    }
  }

  // ── Update settings.json ───────────────────────────────────

  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  // Remove any existing unreal-index-proxy hooks (update in place)
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(h =>
    !(h.matcher === 'Grep|Glob|Bash' &&
      h.hooks?.some(hh => (hh.command || '').includes('unreal-index-proxy')))
  );

  // Add the new hook
  settings.hooks.PreToolUse.push({
    matcher: 'Grep|Glob|Bash',
    hooks: [{ type: 'command', command: proxyCommand }],
  });

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  if (!silent) console.log(`  Updated ${settingsPath}`);

  // ── Update CLAUDE.local.md ─────────────────────────────────

  let searchInstructions = readFileSync(join(__dirname, 'search-instructions.md'), 'utf-8');

  // Substitute template placeholders
  const dashboardPort = owningPort || 3847;
  searchInstructions = searchInstructions.replace(/\{\{PORT\}\}/g, String(dashboardPort));

  const defaultWsName = wsConfig?.defaultWorkspace || Object.keys(wsConfig?.workspaces || {})[0] || 'main';
  if (owningWorkspace && owningWorkspace !== defaultWsName) {
    const wsBlock = `### Workspace-Specific MCP Configuration\n\n` +
      `This project is indexed by the **"${owningWorkspace}"** workspace. ` +
      `When using unreal-index MCP tools, you MUST pass \`workspace: "${owningWorkspace}"\` ` +
      `to every tool call. Example:\n\n` +
      '```\n' +
      `mcp__unreal-index__unreal_find_type with name: "MyClass", workspace: "${owningWorkspace}"\n` +
      `mcp__unreal-index__unreal_grep with pattern: "SomePattern", workspace: "${owningWorkspace}"\n` +
      '```\n\n' +
      `This ensures queries go to the correct index. Omitting the workspace parameter will ` +
      `query the default workspace ("${defaultWsName}"), which will NOT have this project's files.`;
    searchInstructions = searchInstructions.replace('{{WORKSPACE_INSTRUCTIONS}}', wsBlock);
  } else {
    searchInstructions = searchInstructions.replace(/\n?\{\{WORKSPACE_INSTRUCTIONS\}\}\n?/, '\n');
  }

  const BEGIN_MARKER = '<!-- BEGIN unreal-index -->';
  const END_MARKER = '<!-- END unreal-index -->';

  if (existsSync(claudeLocalMdPath)) {
    const existing = readFileSync(claudeLocalMdPath, 'utf-8');
    const beginIdx = existing.indexOf(BEGIN_MARKER);
    const endIdx = existing.indexOf(END_MARKER);
    if (beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx) {
      // Replace existing section between markers
      const before = existing.slice(0, beginIdx).trimEnd();
      const after = existing.slice(endIdx + END_MARKER.length).trimStart();
      const parts = [before, searchInstructions];
      if (after) parts.push(after);
      writeFileSync(claudeLocalMdPath, parts.join('\n\n') + '\n');
      if (!silent) console.log(`  Updated search instructions in ${claudeLocalMdPath}`);
    } else if (!existing.includes('USE UNREAL INDEX MCP TOOLS')) {
      writeFileSync(claudeLocalMdPath, existing.trimEnd() + '\n\n' + searchInstructions + '\n');
      if (!silent) console.log(`  Appended search instructions to ${claudeLocalMdPath}`);
    } else {
      // Legacy marker present but no begin/end markers — replace from the old marker to EOF
      const lines = existing.split('\n');
      const markerLineIdx = lines.findIndex(l => l.includes('USE UNREAL INDEX MCP TOOLS'));
      // The section starts at the ## heading line containing the marker
      const sectionStart = markerLineIdx > 0 && lines[markerLineIdx - 1].startsWith('##') ? markerLineIdx - 1 : markerLineIdx;
      const before = lines.slice(0, sectionStart).join('\n').trimEnd();
      writeFileSync(claudeLocalMdPath, before + '\n\n' + searchInstructions + '\n');
      if (!silent) console.log(`  Replaced search instructions in ${claudeLocalMdPath}`);
    }
  } else {
    writeFileSync(claudeLocalMdPath, '# Claude Code Local Instructions\n\n' + searchInstructions + '\n');
    if (!silent) console.log(`  Created ${claudeLocalMdPath}`);
  }

  return { compiled, proxyCommand, hooksDir: winHooksDir, settingsPath, claudeLocalMdPath };
}

// ── CLI entry point ──────────────────────────────────────────

const isCLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isCLI) {
  const projectDir = process.argv[2];
  if (!projectDir) {
    console.error('Usage: node install.js <project-directory>');
    console.error('');
    console.error('  project-directory  Path to your project root (the directory');
    console.error('                     where .claude/ exists or will be created)');
    console.error('');
    console.error('Example:');
    console.error('  node install.js D:\\p4\\games\\Games\\MyProject\\Script');
    process.exit(1);
  }

  const resolved = resolve(projectDir);
  console.log(`\nInstalling unreal-index hooks to: ${resolved}\n`);

  try {
    const result = await installHooks(resolved);
    console.log('');
    console.log('Hooks installed successfully!');
    console.log(`  Proxy: ${result.compiled ? 'Go binary (compiled)' : 'Node.js (.mjs fallback)'}`);
    console.log(`  Hooks dir: ${result.hooksDir}`);
    console.log('');
    console.log('Restart Claude Code to activate the hooks.');
  } catch (err) {
    console.error(`\nFailed to install hooks: ${err.message}`);
    process.exit(1);
  }
}
