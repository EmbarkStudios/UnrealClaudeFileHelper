#!/usr/bin/env node

// CLI entry point for unreal-index.
// Validates configuration, auto-regenerates docker-compose.yml, and starts containers.
//
// Usage:
//   node src/cli.js [command] [workspace] [options]
//
// Commands:
//   start [workspace]   validate + start container(s) (default)
//   status              show workspace status
//   validate            validate config only, exit 0/1
//
// Options:
//   --no-regen          skip auto-regeneration of docker-compose.yml
//   --verbose           verbose output

import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

import {
  loadWorkspacesConfig,
  loadWorkspaceConfig,
  validateComposeSync,
  generateDockerComposeContent,
  getWslRoot,
} from './workspace-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ── Output helpers ──────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function log(msg) { console.log(msg); }
function fatal(msg) {
  console.error(`${RED}ERROR${RESET} ${msg}`);
  process.exit(1);
}
function error(msg) { console.error(`${RED}ERROR${RESET} ${msg}`); }
function warn(msg) { console.warn(`${YELLOW}WARN${RESET}  ${msg}`); }
function info(msg) { console.log(`${DIM}INFO${RESET}  ${msg}`); }
function ok(msg) { console.log(`${GREEN}OK${RESET}    ${msg}`); }

// ── Validation ──────────────────────────────────────────────

function validateWorkspaceConfigs(wsConfig) {
  const issues = [];
  for (const name of Object.keys(wsConfig.workspaces)) {
    const config = loadWorkspaceConfig(ROOT, name);
    if (!config) {
      issues.push({ workspace: name, level: 'error', message: `Missing workspace-configs/${name}.json` });
      continue;
    }
    if (!config.projects || !Array.isArray(config.projects)) {
      issues.push({ workspace: name, level: 'warn', message: `No projects array in workspace-configs/${name}.json` });
    } else if (config.projects.length === 0) {
      issues.push({ workspace: name, level: 'warn', message: `workspace-configs/${name}.json has 0 projects — watcher will have nothing to index` });
    }
  }
  return issues;
}

// ── Docker helpers ──────────────────────────────────────────

function checkDocker() {
  if (process.platform === 'win32') {
    try {
      execFileSync('wsl', ['--', 'bash', '-c', 'docker compose version 2>/dev/null'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
      return { ok: true, via: 'wsl' };
    } catch {
      return { ok: false, error: 'Docker Compose not available in WSL. Install Docker Desktop or Docker Engine in WSL.' };
    }
  }
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return { ok: true, via: 'native' };
  } catch {
    return { ok: false, error: 'Docker Compose not available. Install Docker.' };
  }
}

function runDockerCompose(composeArgs) {
  if (process.platform === 'win32') {
    return execFileSync('wsl', [
      '--', 'docker', 'compose', ...composeArgs,
    ], { encoding: 'utf-8', timeout: 120000, cwd: ROOT });
  }
  return execFileSync('docker', ['compose', ...composeArgs], {
    cwd: ROOT, encoding: 'utf-8', timeout: 120000,
  });
}

async function checkHealth(wsConfig, workspaceNames) {
  const results = [];
  for (const name of workspaceNames) {
    const port = wsConfig.workspaces[name].port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = await response.json();
        results.push({
          workspace: name, port, status: 'healthy',
          uptime: data.uptimeSeconds,
          memory: data.memoryMB,
          index: data.memoryIndex,
          version: data.version,
          gitHash: data.gitHash,
        });
      } else {
        results.push({ workspace: name, port, status: 'unhealthy', code: response.status });
      }
    } catch {
      results.push({ workspace: name, port, status: 'unreachable' });
    }
  }
  return results;
}

function formatUptime(seconds) {
  if (seconds == null) return '-';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function printStatus(wsConfig, healthResults) {
  log('');
  log(`${BOLD}unreal-index workspaces${RESET}`);
  log('─'.repeat(70));

  for (const h of healthResults) {
    const statusColor = h.status === 'healthy' ? GREEN : h.status === 'unreachable' ? DIM : RED;
    const statusIcon = h.status === 'healthy' ? 'UP' : h.status === 'unreachable' ? '--' : 'ERR';
    const parts = [
      `  ${h.workspace.padEnd(14)}`,
      `${DIM}:${h.port}${RESET}`,
      `  ${statusColor}${statusIcon.padEnd(4)}${RESET}`,
    ];

    if (h.status === 'healthy') {
      parts.push(`  ${DIM}uptime${RESET} ${formatUptime(h.uptime)}`);
      if (h.memory) parts.push(`  ${DIM}heap${RESET} ${Math.round(h.memory.heapUsed)}MB`);
      if (h.index) {
        const counts = [];
        if (h.index.files) counts.push(`${h.index.files.toLocaleString()} files`);
        if (h.index.types) counts.push(`${h.index.types.toLocaleString()} types`);
        parts.push(`  ${DIM}index${RESET} ${counts.join(', ')}`);
      }
    }

    log(parts.join(''));
  }

  log('');
}

// ── Commands ────────────────────────────────────────────────

async function cmdValidate(wsConfig, options) {
  let hasErrors = false;

  // Validate workspace configs
  const configIssues = validateWorkspaceConfigs(wsConfig);
  for (const issue of configIssues) {
    if (issue.level === 'error') { error(issue.message); hasErrors = true; }
    else { warn(issue.message); }
  }
  if (configIssues.length === 0) ok('All workspace configs present');

  // Validate compose sync
  const composeResult = validateComposeSync(ROOT, wsConfig);
  if (composeResult.inSync) {
    ok('docker-compose.yml is in sync with workspaces.json');
  } else {
    for (const d of composeResult.diffs) {
      warn(`docker-compose.yml: ${d}`);
    }
    hasErrors = true;
  }

  return hasErrors;
}

async function cmdStart(wsConfig, targetWorkspaces, options) {
  // Validate workspace configs
  const configIssues = validateWorkspaceConfigs(wsConfig);
  let hasErrors = false;
  for (const issue of configIssues) {
    if (issue.level === 'error') { error(issue.message); hasErrors = true; }
    else { warn(issue.message); }
  }

  // Validate and auto-regen compose
  const composeResult = validateComposeSync(ROOT, wsConfig);
  if (!composeResult.inSync) {
    if (options.noRegen) {
      warn('docker-compose.yml is out of sync (--no-regen specified, skipping regeneration)');
      for (const d of composeResult.diffs) warn(`  ${d}`);
    } else {
      info('docker-compose.yml is out of sync with workspaces.json — regenerating...');
      for (const d of composeResult.diffs) info(`  ${d}`);
      writeFileSync(join(ROOT, 'docker-compose.yml'), composeResult.expected);
      ok('docker-compose.yml regenerated');
    }
  } else {
    ok('docker-compose.yml is in sync');
  }

  if (hasErrors) {
    fatal(`Cannot start: workspace config errors found (see above). Run "npm run setup" to fix.`);
  }

  // Check Docker
  const docker = checkDocker();
  if (!docker.ok) fatal(docker.error);

  // Start containers
  info(`Starting: ${targetWorkspaces.join(', ')}...`);

  try {
    const output = runDockerCompose(['up', '-d', ...targetWorkspaces]);
    if (options.verbose) log(output);
  } catch (err) {
    fatal(`docker compose up failed:\n${err.stderr || err.stdout || err.message}`);
  }

  // Brief wait then health check
  info('Checking container health...');
  await new Promise(r => setTimeout(r, 3000));

  const health = await checkHealth(wsConfig, targetWorkspaces);
  printStatus(wsConfig, health);

  // Reminder for other components
  const unreachable = health.filter(h => h.status === 'unreachable');
  if (unreachable.length > 0) {
    info(`${unreachable.length} workspace(s) still starting — containers may need 30-60s to load the index.`);
    info(`Run "npm run status" to check again.`);
    log('');
  }

  log(`${DIM}Next steps:${RESET}`);
  for (const name of targetWorkspaces) {
    log(`  ${DIM}$${RESET} npm run watcher -- --workspace ${name}`);
  }
  log(`  ${DIM}$${RESET} npm run bridge`);
  log('');
}

async function cmdStatus(wsConfig) {
  const allWorkspaces = Object.keys(wsConfig.workspaces);
  const health = await checkHealth(wsConfig, allWorkspaces);
  printStatus(wsConfig, health);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse command and options
  const positional = args.filter(a => !a.startsWith('-'));
  const command = positional[0] || 'start';
  const workspaceArg = ['start', 'status', 'validate'].includes(positional[0]) ? positional[1] : positional[0];

  const options = {
    noRegen: args.includes('--no-regen'),
    verbose: args.includes('--verbose'),
  };

  if (args.includes('--help') || args.includes('-h')) {
    log(`
${BOLD}unreal-index${RESET} — startup & validation CLI

${BOLD}Usage:${RESET}
  node src/cli.js [command] [workspace] [options]
  npm start [-- workspace] [-- --verbose]

${BOLD}Commands:${RESET}
  start [workspace]   Validate config, regenerate docker-compose.yml if needed,
                      and start container(s). Default command.
                      Omit workspace to start all.
  status              Show health status of all workspaces.
  validate            Validate config only (exit 0 if OK, 1 if errors).

${BOLD}Options:${RESET}
  --no-regen          Skip auto-regeneration of docker-compose.yml
  --verbose           Show docker compose output
  --help, -h          Show this help
`);
    process.exit(0);
  }

  // Load workspaces.json
  let wsConfig;
  try {
    wsConfig = loadWorkspacesConfig(ROOT);
  } catch (err) {
    fatal(`workspaces.json has invalid JSON: ${err.message}`);
  }
  if (!wsConfig) {
    fatal('workspaces.json not found. Run "npm run setup" first to configure workspaces.');
  }
  const allWorkspaces = Object.keys(wsConfig.workspaces || {});
  if (allWorkspaces.length === 0) {
    fatal('workspaces.json has no workspaces defined. Run "npm run setup" to add one.');
  }

  // Resolve target workspaces
  if (workspaceArg && !wsConfig.workspaces[workspaceArg]) {
    fatal(`Unknown workspace "${workspaceArg}". Available: ${allWorkspaces.join(', ')}`);
  }
  const targetWorkspaces = workspaceArg ? [workspaceArg] : allWorkspaces;

  switch (command) {
    case 'validate': {
      const hasErrors = await cmdValidate(wsConfig, options);
      process.exit(hasErrors ? 1 : 0);
      break;
    }
    case 'status':
      await cmdStatus(wsConfig);
      break;
    case 'start':
      await cmdStart(wsConfig, targetWorkspaces, options);
      break;
    default:
      // Treat unknown command as workspace name for 'start'
      if (wsConfig.workspaces[command]) {
        await cmdStart(wsConfig, [command], options);
      } else {
        fatal(`Unknown command "${command}". Use: start, status, validate`);
      }
  }
}

main().catch(err => {
  fatal(err.message);
});
