# Unreal Index

MCP server for indexing Unreal Engine AngelScript files. Provides fast class/struct/file lookups for Claude Code instead of slow global file searches.

## Installation

```bash
npm install
```

## Configuration

### Quick start (recommended)

Run the interactive setup wizard:

```bash
npm run setup
```

Or on Windows, double-click `setup.bat`.

The wizard will detect your project structure and generate `config.json`.

### Manual configuration

Copy the example config and edit it with your paths:

```bash
cp config.example.json config.json
```

Then edit `config.json` to point to your project directories. See `config.example.json` for the full schema with all supported project types.

> **Note:** `config.json` is git-ignored and local to your machine. Each developer runs `npm run setup` (or copies the example) to create their own config.

## Usage

### Build index manually

```bash
npm run build-index
```

### Run as MCP server

```bash
npm start
```

### Add to Claude Code

Add to your `.claude/settings.json`:

```json
{
  "mcpServers": {
    "unreal-index": {
      "command": "node",
      "args": ["<path-to-unreal-index>/src/server.js"]
    }
  }
}
```

## MCP Tools

### `angelscript_find_type`

Find file(s) containing a class, struct, enum, event, or delegate by name.

```json
{
  "name": "ADiscoveryPlayerController",
  "fuzzy": false,
  "project": "Discovery"
}
```

### `angelscript_find_children`

Find all classes inheriting from a given parent class.

```json
{
  "parentClass": "ADiscoveryPlayerControllerBase",
  "recursive": true
}
```

### `angelscript_browse_module`

List all types and files in a module/directory.

```json
{
  "module": "Discovery.UI",
  "project": "Discovery"
}
```

### `angelscript_refresh_index`

Rebuild the index when files have changed.

## MCP Resources

### `angelscript://index/summary`

Returns a compact summary of the index including project names, module counts, and type statistics.

## Index Statistics

Typical index on a full codebase:
- ~7,000+ files
- ~10,000 classes
- ~3,500 structs
- ~1,300 enums
- Build time: ~14 seconds
