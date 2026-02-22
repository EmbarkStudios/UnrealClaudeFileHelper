# Repository Guidelines

## Project Structure & Module Organization
Core runtime code lives in `src/`:
- `src/service/`: indexing API, SQLite, in-memory query engine, Zoekt integration
- `src/watcher/`: Windows-side file watcher that ingests changes
- `src/bridge/`: MCP bridge (`stdio <-> HTTP`)
- `src/parsers/` and `src/hooks/`: language parsers and Claude hook tooling

UI and setup assets are in `public/`. Workspace definitions are in `workspaces.json` and per-workspace configs in `workspace-configs/`. Utility scripts live in `scripts/` and `tools/`. CI automation is in `.github/workflows/`.

## Build, Test, and Development Commands
- `npm run setup`: launch setup GUI (`src/setup-gui.js`) to generate workspace/service config
- `docker compose up -d`: start workspace containers (primary deployment mode)
- `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`: dev mode with live reload
- `npm run watcher -- --workspace <name>`: start watcher for one workspace
- `npm run bridge`: run MCP bridge locally
- `npm test`: run unit tests (`node --test src/*.test.js`)
- `npm run stress-test`: run stress test suite

## Coding Style & Naming Conventions
Use modern Node.js ESM (`import`/`export`) with 2-space indentation, semicolons, and single quotes. Prefer:
- `PascalCase` for classes
- `camelCase` for variables/functions
- `kebab-case` for file names (for example `watcher-client.js`)

No repo-wide formatter/linter is enforced; keep diffs small and style-consistent with nearby files.

## Testing Guidelines
Primary framework is Node's built-in `node:test` with test files in `src/` named `*.test.js` (for example `src/web-ui.test.js`). Add or update tests for every behavior change, especially in parser, API, and watcher paths. Run targeted tests with `node --test src/<file>.test.js` before opening a PR.

## Commit & Pull Request Guidelines
Follow the existing commit style: short, imperative subjects (for example `Fix watcher ECONNRESET retry...`, `Add Docker containerization...`). Keep one logical change per commit.

PRs should include:
- what changed and why
- linked issue(s) when applicable
- test evidence (commands run)
- screenshots for `public/` UI changes

Do not commit local runtime artifacts such as `config.json`, `*.log`, or `data/`.
