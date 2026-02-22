#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { Agent } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_ID = randomUUID();

// ── Connection pool ──────────────────────────────────────────

const httpAgent = new Agent({
  keepAliveTimeout: 60_000,
  connections: 10,
  pipelining: 1
});

// ── Workspace routing ────────────────────────────────────────

const INSIDE_CONTAINER = !!process.env.INSIDE_CONTAINER;

const workspaceUrls = new Map();
let defaultWorkspace = null;

function loadWorkspacesConfig() {
  if (INSIDE_CONTAINER) {
    // Inside Docker: always route to local service
    workspaceUrls.set('default', 'http://127.0.0.1:3847');
    defaultWorkspace = 'default';
    return;
  }
  const wsPath = join(__dirname, '..', '..', 'workspaces.json');
  try {
    const cfg = JSON.parse(readFileSync(wsPath, 'utf-8'));
    for (const [name, ws] of Object.entries(cfg.workspaces || {})) {
      workspaceUrls.set(name, `http://127.0.0.1:${ws.port}`);
    }
    defaultWorkspace = cfg.defaultWorkspace || [...workspaceUrls.keys()][0];
  } catch {
    workspaceUrls.set('default', 'http://127.0.0.1:3847');
    defaultWorkspace = 'default';
  }
}
loadWorkspacesConfig();

function resolveServiceUrl(workspace) {
  if (workspace && workspaceUrls.has(workspace)) {
    return workspaceUrls.get(workspace);
  }
  if (workspace && !workspaceUrls.has(workspace)) {
    throw new Error(`Unknown workspace "${workspace}". Available: ${[...workspaceUrls.keys()].join(', ')}`);
  }
  return workspaceUrls.get(defaultWorkspace) || 'http://127.0.0.1:3847';
}

const availableWorkspaces = () => [...workspaceUrls.keys()].join(', ');

// ── HTTP helpers ─────────────────────────────────────────────

async function fetchService(serviceUrl, endpoint, params = {}) {
  const url = new URL(endpoint, serviceUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), { dispatcher: httpAgent });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

async function postService(serviceUrl, endpoint) {
  const url = new URL(endpoint, serviceUrl);
  const response = await fetch(url.toString(), { method: 'POST', dispatcher: httpAgent });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchBatch(serviceUrl, queries) {
  if (!queries || !Array.isArray(queries) || queries.length === 0) {
    throw new Error('queries array is required and must not be empty');
  }
  const url = new URL('/batch', serviceUrl);
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries }),
    dispatcher: httpAgent
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

// ── Workspace parameter definition ───────────────────────────

const workspaceParam = {
  workspace: {
    type: 'string',
    description: `Workspace to query. Available: ${availableWorkspaces()}. Default: "${defaultWorkspace}"`
  }
};

class UnrealIndexBridge {
  constructor() {
    this.server = new Server(
      {
        name: 'unreal-index',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
        instructions: `IMPORTANT: Always use these unreal-index tools instead of Bash commands for searching Unreal Engine/AngelScript code.
- Use unreal_find_file instead of \`find\` or \`ls\` to locate source files by name
- Use unreal_grep instead of \`grep\`, \`rg\`, or \`sed -n\` to search file contents or find line numbers
- Use unreal_find_type instead of grep to locate class/struct/enum definitions
- Use unreal_find_member instead of grep to locate function/property definitions
- Use the Read tool (not sed/cat/head) to read file contents after finding them
Never fall back to Bash find/grep — these tools are faster, project-aware, and return structured results.
If a search returns no results, check the hints in the response for guidance (wrong project filter, try fuzzy, etc).
Available workspaces: ${availableWorkspaces()}. Default workspace: "${defaultWorkspace}". Use the "workspace" parameter to query a specific workspace.`,
      }
    );
  }

  async initialize() {
    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'unreal_find_type',
            description: 'Find file(s) containing a class, struct, enum, event, or delegate by name. Use INSTEAD of bash grep/find for locating type definitions. Searches AngelScript, C++, and Blueprint assets. Returns file path and line number.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Type name to search for (e.g. ADiscoveryPlayerController, AActor, FVector, ESpectatorState)'
                },
                fuzzy: {
                  type: 'boolean',
                  default: false,
                  description: 'Enable fuzzy/partial matching for uncertain names'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'blueprint'],
                  default: 'all',
                  description: 'Filter by source language. Note: C++ types exposed to AngelScript via bindings are stored as cpp, so use "all" (default) to find all types usable from AngelScript.'
                },
                kind: {
                  type: 'string',
                  enum: ['class', 'struct', 'enum', 'interface', 'delegate', 'event', 'namespace'],
                  description: 'Filter by type kind'
                },
                maxResults: {
                  type: 'number',
                  default: 10,
                  description: 'Maximum results to return'
                },
                includeAssets: {
                  type: 'boolean',
                  description: 'Include blueprint/asset types in results. Default: true for exact match, false for fuzzy.'
                },
                contextLines: {
                  type: 'number',
                  default: 0,
                  description: 'Lines of source context to include around the type definition. Set to 5-10 to see the type definition inline without needing to Read the file.'
                },
                ...workspaceParam
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_find_children',
            description: 'Find all classes inheriting from a given parent class. Includes source code types (AngelScript, C++) and Blueprint subclasses.',
            inputSchema: {
              type: 'object',
              properties: {
                parentClass: {
                  type: 'string',
                  description: 'Parent class name (e.g. AActor, UActorComponent, ADiscoveryPlayerControllerBase)'
                },
                recursive: {
                  type: 'boolean',
                  default: true,
                  description: 'Include all descendants, not just direct children'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'blueprint'],
                  default: 'all',
                  description: 'Filter by source language. Note: C++ types exposed to AngelScript via bindings are stored as cpp, so use "all" (default) to find all types usable from AngelScript.'
                },
                maxResults: {
                  type: 'number',
                  default: 50,
                  description: 'Maximum results to return'
                },
                ...workspaceParam
              },
              required: ['parentClass']
            }
          },
          {
            name: 'unreal_browse_module',
            description: 'List all types and files in a module/directory. Use to explore a specific area of the codebase.',
            inputSchema: {
              type: 'object',
              properties: {
                module: {
                  type: 'string',
                  description: 'Module path (e.g. Discovery.UI, Engine.Source.Runtime, EnginePlugins.Online)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, or cpp'
                },
                maxResults: {
                  type: 'number',
                  default: 100,
                  description: 'Maximum types to return'
                },
                ...workspaceParam
              },
              required: ['module']
            }
          },
          {
            name: 'unreal_find_file',
            description: 'Find source files by filename. Searches AngelScript (.as), C++ (.h, .cpp), and config (.ini) files. Pass only the filename (not a full path). If no results with a project filter, retry without it. Do NOT fall back to bash find commands.',
            inputSchema: {
              type: 'object',
              properties: {
                filename: {
                  type: 'string',
                  description: 'Filename to search for (e.g. Actor, PlayerController, GameMode, DefaultEngine.ini)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins, DiscoveryConfig, EngineConfig)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'config'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, cpp, or config'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                },
                ...workspaceParam
              },
              required: ['filename']
            }
          },
          {
            name: 'unreal_refresh_index',
            description: 'Rebuild the file index. Optionally specify a language to rebuild only that index.',
            inputSchema: {
              type: 'object',
              properties: {
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Language to refresh: all, angelscript, or cpp'
                },
                ...workspaceParam
              }
            }
          },
          {
            name: 'unreal_find_member',
            description: 'Find functions, properties, or enum values by name. Search across class/struct members in AngelScript and C++. Use this to find method implementations, property definitions, or enum values. Note: Blueprint members are not available (binary format) — use unreal_find_type or unreal_find_asset for blueprint classes.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Member name to search for (e.g. BeginPlay, TakeDamage, MaxHealth, DeathCam)'
                },
                fuzzy: {
                  type: 'boolean',
                  default: false,
                  description: 'Enable fuzzy/partial matching'
                },
                containingType: {
                  type: 'string',
                  description: 'Filter to members of a specific type (e.g. AActor, UWidget)'
                },
                memberKind: {
                  type: 'string',
                  enum: ['function', 'property', 'enum_value'],
                  description: 'Filter by member kind'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                },
                contextLines: {
                  type: 'number',
                  default: 0,
                  description: 'Lines of source context around each member definition. Set to 3-5 to see signatures and surrounding code inline.'
                },
                includeSignatures: {
                  type: 'boolean',
                  default: false,
                  description: 'Include the source signature line for each member. Lightweight alternative to contextLines when you only need the declaration.'
                },
                ...workspaceParam
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_explain_type',
            description: 'Get comprehensive information about a type in a single call: definition, members (functions/properties), and children. Replaces the common pattern of find_type + find_member + find_children. Use this when you need to understand a class or struct.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Type name to look up (e.g. AActor, UWidget, FVector)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language'
                },
                contextLines: {
                  type: 'number',
                  default: 0,
                  description: 'Lines of source context around the type definition and member declarations'
                },
                includeMembers: {
                  type: 'boolean',
                  default: true,
                  description: 'Include member functions, properties, and enum values'
                },
                includeChildren: {
                  type: 'boolean',
                  default: true,
                  description: 'Include child classes/structs that inherit from this type'
                },
                maxFunctions: {
                  type: 'number',
                  default: 30,
                  description: 'Maximum functions to return (independent budget from properties)'
                },
                maxProperties: {
                  type: 'number',
                  default: 30,
                  description: 'Maximum properties to return (independent budget from functions)'
                },
                maxChildren: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum children to return'
                },
                ...workspaceParam
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_find_asset',
            description: 'Find Unreal assets (Blueprints, Materials, Maps, DataAssets, etc.) by name. Searches 400K+ indexed assets. Returns content browser paths, asset class type, and parent class for Blueprints. By default uses partial matching (fuzzy=true) — set fuzzy=false only when you need an exact name match. Works offline without a running editor.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Asset name to search for (e.g. BP_ATK_MapBorder, M_Highlight, MI_Default). Partial names work with fuzzy=true (default).'
                },
                fuzzy: {
                  type: 'boolean',
                  default: true,
                  description: 'Enable partial/substring matching (default: true). Set to false for exact name match only.'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (DiscoveryContent, PioneerContent, EngineContent)'
                },
                folder: {
                  type: 'string',
                  description: 'Filter by content browser folder path (e.g. /Game/Discovery/Props)'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                },
                ...workspaceParam
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_grep',
            description: 'Search file contents for a pattern (regex or literal string). Use INSTEAD of bash grep/rg/sed. Scoped to indexed projects. Use for finding usages, string references, variable assignments, function calls, or any content pattern. Use contextLines for surrounding code. Set includeAssets=true to also search asset names/paths.',
            inputSchema: {
              type: 'object',
              properties: {
                pattern: {
                  type: 'string',
                  description: 'Search pattern (regex supported, e.g. "GameModeTagExclusionFilter", "UPROPERTY.*EditAnywhere")'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins, DiscoveryConfig, EngineConfig)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'config'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, cpp, or config'
                },
                caseSensitive: {
                  type: 'boolean',
                  default: true,
                  description: 'Case sensitive search'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum matching lines to return'
                },
                contextLines: {
                  type: 'number',
                  default: 0,
                  description: 'Lines of context before and after each match'
                },
                includeAssets: {
                  type: 'boolean',
                  default: false,
                  description: 'Also search asset names/paths and return matches in an "assets" section'
                },
                ...workspaceParam
              },
              required: ['pattern']
            }
          },
          {
            name: 'unreal_list_modules',
            description: 'List available modules/directories in the codebase. Use to discover code organization and navigate the module tree.',
            inputSchema: {
              type: 'object',
              properties: {
                parent: {
                  type: 'string',
                  description: 'Parent module path to list children of (empty for root level modules)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language'
                },
                depth: {
                  type: 'number',
                  default: 1,
                  description: 'How many levels deep to return'
                },
                ...workspaceParam
              }
            }
          },
          {
            name: 'unreal_batch',
            description: 'Execute multiple index queries in a single call. Use when you need results from several queries (e.g. look up 3 types at once). Each query specifies a method and arguments. Maximum 10 queries per batch.',
            inputSchema: {
              type: 'object',
              properties: {
                queries: {
                  type: 'array',
                  description: 'Array of queries to execute',
                  maxItems: 10,
                  items: {
                    type: 'object',
                    properties: {
                      method: {
                        type: 'string',
                        enum: ['findTypeByName', 'findMember', 'findChildrenOf', 'findFileByName', 'findAssetByName', 'listModules', 'browseModule'],
                        description: 'Query method to call'
                      },
                      args: {
                        type: 'array',
                        description: 'Arguments array for the method. E.g. ["AActor", {"project": "Discovery"}] for findTypeByName.'
                      }
                    },
                    required: ['method', 'args']
                  }
                },
                ...workspaceParam
              },
              required: ['queries']
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const callStartMs = performance.now();

      // Resolve workspace → service URL
      let serviceUrl;
      try {
        serviceUrl = resolveServiceUrl(args?.workspace);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        };
      }

      // Fire-and-forget analytics tracking
      const trackCall = (result) => {
        const durationMs = Math.round(performance.now() - callStartMs);
        const resultText = result?.content?.[0]?.text;
        const resultSize = resultText ? resultText.length : 0;
        const argsSummary = args ? JSON.stringify(Object.fromEntries(
          Object.entries(args).filter(([k]) => k !== 'workspace').map(([k, v]) => [k, typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : v])
        )) : null;
        fetch(new URL('/internal/mcp-tool-call', serviceUrl).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: name, args: argsSummary, durationMs, resultSize, sessionId: SESSION_ID }),
          dispatcher: httpAgent
        }).catch(() => {});
      };

      try {
        let toolResult;
        switch (name) {
          case 'unreal_find_type':
            toolResult = await fetchService(serviceUrl, '/find-type', {
              name: args.name, fuzzy: args.fuzzy, project: args.project,
              language: args.language, kind: args.kind, maxResults: args.maxResults,
              includeAssets: args.includeAssets, contextLines: args.contextLines
            });
            break;

          case 'unreal_find_children':
            toolResult = await fetchService(serviceUrl, '/find-children', {
              parent: args.parentClass || args.parent || args.name || args.className, recursive: args.recursive,
              project: args.project, language: args.language, maxResults: args.maxResults
            });
            break;

          case 'unreal_browse_module':
            toolResult = await fetchService(serviceUrl, '/browse-module', {
              module: args.module, project: args.project,
              language: args.language, maxResults: args.maxResults
            });
            break;

          case 'unreal_find_file':
            toolResult = await fetchService(serviceUrl, '/find-file', {
              filename: args.filename || args.name, project: args.project,
              language: args.language, maxResults: args.maxResults
            });
            break;

          case 'unreal_refresh_index': {
            const endpoint = args.language && args.language !== 'all'
              ? `/refresh?language=${args.language}`
              : '/refresh';
            toolResult = await postService(serviceUrl, endpoint);
            break;
          }

          case 'unreal_find_member':
            toolResult = await fetchService(serviceUrl, '/find-member', {
              name: args.name, fuzzy: args.fuzzy, containingType: args.containingType,
              memberKind: args.memberKind, project: args.project, language: args.language,
              maxResults: args.maxResults, contextLines: args.contextLines,
              includeSignatures: args.includeSignatures
            });
            break;

          case 'unreal_explain_type':
            toolResult = await fetchService(serviceUrl, '/explain-type', {
              name: args.name, project: args.project, language: args.language,
              contextLines: args.contextLines, includeMembers: args.includeMembers,
              includeChildren: args.includeChildren, maxFunctions: args.maxFunctions,
              maxProperties: args.maxProperties, maxChildren: args.maxChildren
            });
            break;

          case 'unreal_find_asset':
            toolResult = await fetchService(serviceUrl, '/find-asset', {
              name: args.name, fuzzy: args.fuzzy !== false,
              project: args.project, folder: args.folder, maxResults: args.maxResults
            });
            break;

          case 'unreal_grep':
            toolResult = await fetchService(serviceUrl, '/grep', {
              pattern: args.pattern || args.query || args.search, project: args.project, language: args.language,
              caseSensitive: args.caseSensitive, maxResults: args.maxResults,
              contextLines: args.contextLines, includeAssets: args.includeAssets
            });
            break;

          case 'unreal_list_modules':
            toolResult = await fetchService(serviceUrl, '/list-modules', {
              parent: args.parent, project: args.project,
              language: args.language, depth: args.depth
            });
            break;

          case 'unreal_batch':
            toolResult = await fetchBatch(serviceUrl, args.queries);
            break;

          default: {
            const errResult = {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true
            };
            trackCall(errResult);
            return errResult;
          }
        }

        const mcpResult = {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }]
        };
        trackCall(mcpResult);
        return mcpResult;
      } catch (error) {
        const isConnectionError = error.cause?.code === 'ECONNREFUSED' ||
                                  error.message.includes('ECONNREFUSED') ||
                                  error.message.includes('fetch failed');

        let errResult;
        if (isConnectionError) {
          const wsName = args?.workspace || defaultWorkspace;
          errResult = {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: `Unreal Index Service is not running (workspace: ${wsName})`,
                hint: `Start the container: docker compose up ${wsName}`
              }, null, 2)
            }],
            isError: true
          };
        } else {
          errResult = {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true
          };
        }
        trackCall(errResult);
        return errResult;
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          {
            uri: 'unreal://index/summary',
            name: 'Unreal Index Summary',
            description: 'Compact summary of the code index: project names, languages, type statistics, and indexing status',
            mimeType: 'application/json'
          },
          {
            uri: 'unreal://index/status',
            name: 'Unreal Index Status',
            description: 'Current indexing status for each language (ready, indexing, error)',
            mimeType: 'application/json'
          }
        ]
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const serviceUrl = resolveServiceUrl(null);

      if (uri === 'unreal://index/summary' || uri === 'angelscript://index/summary') {
        try {
          const summary = await fetchService(serviceUrl, '/summary');
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(summary, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: error.message }, null, 2)
              }
            ]
          };
        }
      }

      if (uri === 'unreal://index/status') {
        try {
          const status = await fetchService(serviceUrl, '/status');
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(status, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: error.message }, null, 2)
              }
            ]
          };
        }
      }

      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Unknown resource: ${uri}`
          }
        ]
      };
    });
  }

  async run() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const bridge = new UnrealIndexBridge();
bridge.run().catch(console.error);
