# Unreal Index

MCP server for indexing Unreal Engine AngelScript files. Provides fast class/struct/file lookups for Claude Code instead of slow global file searches.

## Installation

```bash
npm install
```

## Configuration

Edit `config.json` to specify project paths:

```json
{
  "projects": [
    {
      "name": "Discovery",
      "paths": ["D:\\p4\\games\\Games\\Discovery\\Script"]
    },
    {
      "name": "Pioneer",
      "paths": ["D:\\p4\\games\\Games\\Pioneer\\Script"]
    },
    {
      "name": "Shared",
      "paths": ["D:\\p4\\games\\Games\\Shared\\Plugins"],
      "recursive": true
    }
  ],
  "exclude": ["**/Editor/**", "**/*_Test.as"],
  "cacheFile": "data/index.json"
}
```

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
      "args": ["D:\\p4\\games\\Games\\Tools\\unreal-index\\src\\server.js"]
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
