import { v7 as uuidv7 } from 'uuid';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Searcher } from './searcher.js';
import type { Indexer } from './indexer.js';
import { parseChunkId } from './indexer.js';
import type { MetadataStore } from './metadata-db.js';
import type { ProjectConfig } from './types.js';
import { prompts, buildProjectOverviewSections } from './prompts/index.js';

const HIGH_CONFIDENCE_THRESHOLD = 0.6;
const LOW_CONFIDENCE_THRESHOLD = 0.4;

/** Sanitize a language identifier for use in markdown code fences */
function sanitizeLang(lang: string): string {
  // Only allow alphanumeric, hyphens, underscores, dots, plus signs
  return lang.replace(/[^a-zA-Z0-9_.+-]/g, '');
}

/** Build a compact Defines/Uses line for search results */
function formatSymbolsLine(defines: string[], uses: string[]): string {
  if (defines.length === 0 && uses.length === 0) return '';
  const parts: string[] = [];
  if (defines.length > 0) parts.push(`Defines: ${defines.join(', ')}`);
  if (uses.length > 0) parts.push(`Uses: ${uses.join(', ')}`);
  return '\n' + parts.join(' | ');
}

/** Normalized location info extracted from a Qdrant chunk payload */
interface ChunkLocation {
  project: string;
  file: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  kind: string | null;
  service: string | null;
  boundedContext: string | null;
}

/** Extract location fields from a Qdrant payload with safe type checks */
function resolveChunkLocation(payload: Record<string, unknown>): ChunkLocation {
  return {
    project: typeof payload['project'] === 'string' ? payload['project'] : 'unknown',
    file: typeof payload['file'] === 'string' ? payload['file'] : 'unknown',
    startLine: typeof payload['startLine'] === 'number' ? payload['startLine'] : 0,
    endLine: typeof payload['endLine'] === 'number' ? payload['endLine'] : 0,
    symbolName: typeof payload['symbol_name'] === 'string' ? payload['symbol_name'] : null,
    kind: typeof payload['kind'] === 'string' ? payload['kind'] : null,
    service: typeof payload['service'] === 'string' ? payload['service'] : null,
    boundedContext:
      typeof payload['bounded_context'] === 'string' ? payload['bounded_context'] : null,
  };
}

export interface McpHandlerConfig {
  searcher: Searcher;
  indexer: Indexer;
  /** Callback to get currently registered projects grouped by group name */
  getProjects: () => Map<string, ProjectConfig[]>;
  /** Callback to get all known group names */
  getGroupNames: () => string[];
  /** Optional metadata store for git history tools */
  metadataStore?: MetadataStore;
}

type TransportEntry = {
  transport: SSEServerTransport | StreamableHTTPServerTransport;
  created: number;
  lastActivity: number;
};

type ReindexJob = {
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  groups: string[];
  chunksProcessed: number;
  error?: string;
};

export type McpMode = 'coding' | 'support';

/** Tool names available in each mode */
const CODING_TOOLS = new Set([
  'search_code',
  'get_chunk',
  'find_usages',
  'health_check',
  'reindex',
]);

const SUPPORT_TOOLS = new Set([
  'search_code',
  'get_chunk',
  'find_usages',
  'health_check',
  'get_chunk_meta',
  'search_changes',
  'explain_feature',
  'recent_changes',
  'impact_analysis',
]);

export class McpHandler {
  private searcher: Searcher;
  private indexer: Indexer;
  private getProjects: () => Map<string, ProjectConfig[]>;
  private getGroupNames: () => string[];
  private metadataStore: MetadataStore | null;
  private transports: Record<string, TransportEntry> = {};
  private servers = new Map<string, McpServer>();
  private sessionModes = new Map<string, McpMode>();
  private reindexJobs = new Map<string, ReindexJob>();
  private sessionCreationLocks = new Set<string>();

  private readonly SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 4; // 4 hours idle timeout
  private readonly REINDEX_JOB_TTL_MS = 1000 * 60 * 60; // keep completed jobs for 1 hour
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: McpHandlerConfig) {
    this.searcher = config.searcher;
    this.indexer = config.indexer;
    this.getProjects = config.getProjects;
    this.getGroupNames = config.getGroupNames;
    this.metadataStore = config.metadataStore ?? null;

    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
    this.cleanupInterval.unref(); // Don't hold event loop open
  }

  /** Mount all MCP routes on the Express app (coding + support modes) */
  mount(app: Express): void {
    // Coding mode (backwards-compatible paths)
    app.get('/sse', (req, res) => this.handleSSE(req, res, 'coding'));
    app.post('/messages', (req, res) => this.handleMessages(req, res));
    app.all('/mcp', (req, res) => this.handleStreamableHTTP(req, res, 'coding'));

    // Support mode
    app.get('/support/sse', (req, res) => this.handleSSE(req, res, 'support'));
    app.post('/support/messages', (req, res) => this.handleMessages(req, res));
    app.all('/support/mcp', (req, res) => this.handleStreamableHTTP(req, res, 'support'));
  }

  /** Graceful shutdown: stop cleanup interval and remove all sessions */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const sessionId of Object.keys(this.transports)) {
      this.cleanupSession(sessionId);
    }
    this.reindexJobs.clear();
  }

  private getMcpServer(sessionId: string, mode: McpMode): McpServer {
    let server = this.servers.get(sessionId);
    if (!server) {
      server = this.createMcpServer(mode);
      this.servers.set(sessionId, server);
      this.sessionModes.set(sessionId, mode);
    }
    return server;
  }

  private cleanupSession(sessionId: string): void {
    delete this.transports[sessionId];
    this.servers.delete(sessionId);
    this.sessionModes.delete(sessionId);
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, entry] of Object.entries(this.transports)) {
      if (now - entry.lastActivity > this.SESSION_TIMEOUT_MS) {
        this.cleanupSession(sessionId);
        cleaned++;
      }
    }

    // Evict finished reindex jobs older than TTL
    for (const [jobId, job] of this.reindexJobs.entries()) {
      if (job.status !== 'running' && now - job.startedAt > this.REINDEX_JOB_TTL_MS) {
        this.reindexJobs.delete(jobId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[mcp] Cleaned up ${cleaned} expired sessions/jobs`);
    }
  }

  private isInitializeRequest(v: unknown): v is { method: 'initialize'; params: unknown } {
    if (v == null || typeof v !== 'object') return false;
    const obj = v as Record<string, unknown>;
    return obj.method === 'initialize' && obj.params != null;
  }

  private createMcpServer(mode: McpMode): McpServer {
    let instructions = mode === 'coding' ? prompts.codingInstructions : prompts.supportInstructions;
    const tools = mode === 'coding' ? CODING_TOOLS : SUPPORT_TOOLS;

    const scope = this.searcher.getProjectScope();
    if (scope) {
      instructions += `\n\nThis server is scoped to projects: ${scope.join(', ')}. All searches are automatically filtered.`;
    }

    const server = new McpServer({ name: 'paparats-mcp', version: '0.1.2' }, { instructions });

    // ── Resource: project overview ──────────────────────────────────────────
    server.resource('project-overview', 'context://project-overview', async () => {
      try {
        const groupMap = this.getProjects();
        const sections: string[] = ['# Indexed Projects', ''];

        for (const [group, projects] of groupMap) {
          const stats = await this.indexer.getGroupStats(group);
          sections.push(
            `## Group: ${group} (${stats.points} chunks)`,
            ...projects.map((p) => `- **${p.name}** (${p.languages.join(', ')})`),
            ''
          );
        }

        sections.push(...buildProjectOverviewSections());

        const usage = this.searcher.getUsageStats();
        if (usage.searchCount > 0) {
          sections.push(
            '',
            '## Token Savings',
            `- Searches: ${usage.searchCount}`,
            `- Tokens saved: ~${usage.totalTokensSaved}`
          );
        }

        return {
          contents: [
            {
              uri: 'context://project-overview',
              mimeType: 'text/markdown',
              text: sections.join('\n'),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: 'context://project-overview',
              mimeType: 'text/plain',
              text: `Could not load project overview: ${(err as Error).message}`,
            },
          ],
        };
      }
    });

    // ── Tool: search_code ───────────────────────────────────────────────────
    if (tools.has('search_code'))
      server.tool(
        'search_code',
        prompts.tools.search_code.description,
        {
          query: z.string().describe('Natural language query or code snippet'),
          group: z.string().optional().describe('Specific group or omit for all'),
          project: z.string().default('all').describe('Project name or "all"'),
          limit: z.coerce.number().min(1).max(20).default(5).describe('Max results'),
        },
        async ({ query, group, project, limit }) => {
          try {
            const groupNames = group ? [group] : this.getGroupNames();

            if (groupNames.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No groups registered. Index a project first.',
                  },
                ],
              };
            }

            const allResults: Array<{
              project: string;
              file: string;
              language: string;
              startLine: number;
              endLine: number;
              content: string;
              score: number;
              hash: string;
              chunk_id: string | null;
              symbol_name: string | null;
              kind: string | null;
              defines_symbols: string[];
              uses_symbols: string[];
            }> = [];

            for (const g of groupNames) {
              const response = await this.searcher.expandedSearch(g, query, {
                project,
                limit: limit * 2,
              });
              allResults.push(...response.results);
            }

            const seen = new Set<string>();
            const deduped = allResults.filter((r) => {
              if (seen.has(r.hash)) return false;
              seen.add(r.hash);
              return true;
            });

            deduped.sort((a, b) => b.score - a.score);
            const top = deduped.slice(0, limit);

            if (top.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No results found. Make sure the project is indexed.',
                  },
                ],
              };
            }

            const formatted = top
              .map((r) => {
                const score = (r.score * 100).toFixed(1);
                const symbolInfo = r.symbol_name
                  ? ` — ${r.kind ?? 'unknown'}: ${r.symbol_name}`
                  : '';
                const chunkRef = r.chunk_id ? `\n_chunk: ${r.chunk_id}_` : '';
                const symbolsLine = formatSymbolsLine(r.defines_symbols, r.uses_symbols);
                return `**[${r.project}] ${r.file}:${r.startLine}-${r.endLine}** (${score}%${symbolInfo})${symbolsLine}${chunkRef}\n\`\`\`${sanitizeLang(r.language)}\n${r.content}\n\`\`\``;
              })
              .join('\n\n---\n\n');

            const highCount = top.filter((r) => r.score >= HIGH_CONFIDENCE_THRESHOLD).length;
            const lowCount = top.filter((r) => r.score < LOW_CONFIDENCE_THRESHOLD).length;
            const bestScore = top[0]?.score ?? 0;

            let guidance = '';
            if (bestScore < LOW_CONFIDENCE_THRESHOLD) {
              guidance =
                '> **Low confidence results.** Try rephrasing, use grep or file reading if available, or ask the user for more specific terms.\n\n';
            } else if (bestScore < HIGH_CONFIDENCE_THRESHOLD) {
              guidance =
                '> **Partial match results.** Supplement with grep or file reading if available, or try rephrasing for better coverage.\n\n';
            } else if (highCount > 0 && lowCount > 0) {
              guidance = `> **${highCount} high-confidence and ${lowCount} low-confidence results.** Review low-confidence results carefully.\n\n`;
            }

            return { content: [{ type: 'text' as const, text: guidance + formatted }] };
          } catch (err) {
            const details = group ? `group "${group}"` : `${this.getGroupNames().length} groups`;

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Search failed for "${query}" in ${details}:\n${(err as Error).message}\n\nTry:\n• Check if projects are indexed (health_check)\n• Simplify query\n• Specify group parameter`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Tool: health_check ──────────────────────────────────────────────────
    if (tools.has('health_check'))
      server.tool('health_check', prompts.tools.health_check.description, {}, async () => {
        try {
          const groups = await this.indexer.listGroups();
          const jobs = Object.fromEntries(this.reindexJobs.entries());

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ status: 'ok', groups, reindexJobs: jobs }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ status: 'error', error: (err as Error).message }, null, 2),
              },
            ],
            isError: true,
          };
        }
      });

    // ── Tool: get_chunk ──────────────────────────────────────────────────────
    if (tools.has('get_chunk'))
      server.tool(
        'get_chunk',
        prompts.tools.get_chunk.description,
        {
          chunk_id: z.string().describe('Chunk ID from search_code results'),
          radius_lines: z.coerce
            .number()
            .min(0)
            .max(200)
            .default(0)
            .describe('Lines of surrounding context to include (0-200)'),
        },
        async ({ chunk_id, radius_lines }) => {
          try {
            const payload = await this.indexer.getChunkById(chunk_id);

            if (!payload) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Chunk not found: ${chunk_id}\n\nThe chunk may have been removed during reindexing. Try searching again.`,
                  },
                ],
              };
            }

            const project = payload['project'] as string;
            const file = payload['file'] as string;
            const language = payload['language'] as string;
            const startLine = payload['startLine'] as number;
            const endLine = payload['endLine'] as number;
            const content = payload['content'] as string;
            const symbolName = payload['symbol_name'] as string | null;
            const kind = payload['kind'] as string | null;
            const definesSymbols = (payload['defines_symbols'] as string[]) ?? [];
            const usesSymbols = (payload['uses_symbols'] as string[]) ?? [];

            let text = '';

            // Metadata header
            text += `**[${project}] ${file}:${startLine}-${endLine}**\n`;
            if (symbolName) text += `Symbol: \`${symbolName}\` (${kind ?? 'unknown'})\n`;
            const symbolsLine = formatSymbolsLine(definesSymbols, usesSymbols);
            if (symbolsLine) text += symbolsLine.slice(1) + '\n'; // slice(1) removes leading newline
            text += '\n';

            if (radius_lines > 0) {
              const parsed = parseChunkId(chunk_id);
              if (parsed) {
                const adjacentChunks = await this.indexer.getAdjacentChunks(
                  parsed.group,
                  parsed.project,
                  parsed.file,
                  startLine,
                  endLine,
                  radius_lines
                );

                if (adjacentChunks.length > 1) {
                  text += `_Showing ${adjacentChunks.length} chunks within ${radius_lines} lines of context:_\n\n`;
                  for (const chunk of adjacentChunks) {
                    const sl = chunk['startLine'] as number;
                    const el = chunk['endLine'] as number;
                    const c = chunk['content'] as string;
                    const isTarget = sl === startLine && el === endLine;
                    const marker = isTarget ? ' ← target' : '';
                    text += `**Lines ${sl}-${el}${marker}**\n\`\`\`${sanitizeLang(language)}\n${c}\n\`\`\`\n\n`;
                  }

                  return { content: [{ type: 'text' as const, text }] };
                }
              }
            }

            // Single chunk (no radius or no adjacent chunks found)
            text += `\`\`\`${sanitizeLang(language)}\n${content}\n\`\`\``;

            return { content: [{ type: 'text' as const, text }] };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to retrieve chunk: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Tool: get_chunk_meta ────────────────────────────────────────────────
    if (tools.has('get_chunk_meta'))
      server.tool(
        'get_chunk_meta',
        prompts.tools.get_chunk_meta.description,
        {
          chunk_id: z.string().describe('Chunk ID from search_code results'),
          commit_limit: z.coerce
            .number()
            .min(1)
            .max(50)
            .default(10)
            .describe('Max number of recent commits to return'),
        },
        async ({ chunk_id, commit_limit }) => {
          try {
            const payload = await this.indexer.getChunkById(chunk_id);

            if (!payload) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Chunk not found: ${chunk_id}\n\nThe chunk may have been removed during reindexing. Try searching again.`,
                  },
                ],
              };
            }

            if (!this.metadataStore) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Git metadata is not available. The metadata store is not configured.`,
                  },
                ],
              };
            }

            const project = typeof payload['project'] === 'string' ? payload['project'] : 'unknown';
            const file = typeof payload['file'] === 'string' ? payload['file'] : 'unknown';
            const startLine = typeof payload['startLine'] === 'number' ? payload['startLine'] : 0;
            const endLine = typeof payload['endLine'] === 'number' ? payload['endLine'] : 0;
            const symbolName =
              typeof payload['symbol_name'] === 'string' ? payload['symbol_name'] : null;
            const kind = typeof payload['kind'] === 'string' ? payload['kind'] : null;
            const service = typeof payload['service'] === 'string' ? payload['service'] : null;
            const boundedContext =
              typeof payload['bounded_context'] === 'string' ? payload['bounded_context'] : null;
            const tags = Array.isArray(payload['tags']) ? (payload['tags'] as string[]) : [];

            let text = '';

            // Header
            const symbolSuffix = symbolName ? ` — \`${symbolName}\` (${kind ?? 'unknown'})` : '';
            text += `**[${project}] ${file}:${startLine}-${endLine}**${symbolSuffix}\n\n`;

            // Commits table
            const commits = this.metadataStore.getCommits(chunk_id, commit_limit);
            if (commits.length > 0) {
              text += `### Recent Commits (${commits.length})\n\n`;
              text += '| Date | Author | Message |\n';
              text += '|------|--------|---------|\n';
              for (const c of commits) {
                const date = c.committed_at.split('T')[0] ?? c.committed_at;
                text += `| ${date} | ${c.author_email} | ${c.message_summary} |\n`;
              }
            } else {
              text += '_No git history available for this chunk._\n';
            }

            // Tickets
            const tickets = this.metadataStore.getTickets(chunk_id);
            if (tickets.length > 0) {
              text += `\n### Tickets\n`;
              for (const t of tickets) {
                text += `- ${t.ticket_key} (${t.source})\n`;
              }
            }

            // Metadata section (service, bounded_context, tags)
            const metaParts: string[] = [];
            if (service) metaParts.push(`Service: ${service}`);
            if (boundedContext) metaParts.push(`Context: ${boundedContext}`);
            if (tags.length > 0) metaParts.push(`Tags: ${tags.join(', ')}`);
            if (metaParts.length > 0) {
              text += `\n### Metadata\n${metaParts.join(' | ')}\n`;
            }

            return { content: [{ type: 'text' as const, text }] };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to retrieve chunk metadata: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Tool: search_changes ─────────────────────────────────────────────────
    if (tools.has('search_changes'))
      server.tool(
        'search_changes',
        prompts.tools.search_changes.description,
        {
          query: z.string().describe('Semantic search query'),
          since: z
            .string()
            .optional()
            .describe(
              'ISO 8601 date string (e.g. "2024-01-01") — only return chunks modified after this date'
            ),
          group: z.string().optional().describe('Specific group or omit for all'),
          project: z.string().default('all').describe('Project name or "all"'),
          limit: z.coerce.number().min(1).max(20).default(5).describe('Max results'),
        },
        async ({ query, since, group, project, limit }) => {
          try {
            const groupNames = group ? [group] : this.getGroupNames();

            if (groupNames.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No groups registered. Index a project first.',
                  },
                ],
              };
            }

            const additionalFilter: { must: Array<Record<string, unknown>> } = { must: [] };
            if (since) {
              additionalFilter.must.push({
                key: 'last_commit_at',
                range: { gte: since },
              });
            }

            const allResults: Array<{
              project: string;
              file: string;
              language: string;
              startLine: number;
              endLine: number;
              content: string;
              score: number;
              hash: string;
              chunk_id: string | null;
              symbol_name: string | null;
              kind: string | null;
              last_commit_at: string | null;
              defines_symbols: string[];
              uses_symbols: string[];
            }> = [];

            for (const g of groupNames) {
              const response = await this.searcher.searchWithFilter(g, query, additionalFilter, {
                project,
                limit: limit * 2,
              });
              allResults.push(...response.results);
            }

            const seen = new Set<string>();
            const deduped = allResults.filter((r) => {
              if (seen.has(r.hash)) return false;
              seen.add(r.hash);
              return true;
            });

            deduped.sort((a, b) => b.score - a.score);
            const top = deduped.slice(0, limit);

            if (top.length === 0) {
              const sinceNote = since ? ` modified after ${since}` : '';
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No results found for "${query}"${sinceNote}. Make sure the project is indexed and has git metadata.`,
                  },
                ],
              };
            }

            const formatted = top
              .map((r) => {
                const score = (r.score * 100).toFixed(1);
                const symbolInfo = r.symbol_name
                  ? ` — ${r.kind ?? 'unknown'}: ${r.symbol_name}`
                  : '';
                const lastChanged = r.last_commit_at
                  ? ` — last changed ${r.last_commit_at.split('T')[0] ?? r.last_commit_at}`
                  : '';
                const chunkRef = r.chunk_id ? `\n_chunk: ${r.chunk_id}_` : '';
                const symbolsLine = formatSymbolsLine(r.defines_symbols, r.uses_symbols);
                return `**[${r.project}] ${r.file}:${r.startLine}-${r.endLine}** (${score}%${symbolInfo})${lastChanged}${symbolsLine}${chunkRef}\n\`\`\`${sanitizeLang(r.language)}\n${r.content}\n\`\`\``;
              })
              .join('\n\n---\n\n');

            const sinceNote = since ? `\n_Filtered to changes after ${since}_\n\n` : '';

            return { content: [{ type: 'text' as const, text: sinceNote + formatted }] };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Search changes failed: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Tool: reindex ───────────────────────────────────────────────────────
    if (tools.has('reindex'))
      server.tool(
        'reindex',
        prompts.tools.reindex.description,
        {
          group: z.string().optional().describe('Group name or omit for all groups'),
        },
        async ({ group }) => {
          try {
            const groupMap = this.getProjects();
            const targetGroups = group
              ? [[group, groupMap.get(group) ?? []] as const]
              : Array.from(groupMap.entries());

            const groupNames = targetGroups.map(([g]) => g);
            const jobId = uuidv7().slice(0, 8);

            this.reindexJobs.set(jobId, {
              status: 'running',
              startedAt: Date.now(),
              groups: groupNames,
              chunksProcessed: 0,
            });

            (async () => {
              try {
                let total = 0;
                for (const [g, projects] of targetGroups) {
                  if (projects.length === 0) continue;
                  const n = await this.indexer.reindexGroup(g, projects);
                  total += n;
                }

                const job = this.reindexJobs.get(jobId);
                if (job) {
                  this.reindexJobs.set(jobId, {
                    ...job,
                    status: 'completed',
                    chunksProcessed: total,
                  });
                }
              } catch (err) {
                const job = this.reindexJobs.get(jobId);
                if (job) {
                  this.reindexJobs.set(jobId, {
                    ...job,
                    status: 'failed',
                    error: (err as Error).message,
                  });
                }
              }
            })();

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Reindex started for ${groupNames.join(', ')}\nJob ID: ${jobId}\n\nCheck status with health_check tool.`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to start reindex: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Tool: find_usages ─────────────────────────────────────────────────
    if (tools.has('find_usages'))
      server.tool(
        'find_usages',
        prompts.tools.find_usages.description,
        {
          chunk_id: z.string().describe('Chunk ID to find usages of'),
          direction: z
            .enum(['incoming', 'outgoing', 'both'])
            .default('incoming')
            .describe(
              'incoming = who calls this chunk, outgoing = what this chunk calls, both = both directions'
            ),
          relation_types: z
            .array(z.enum(['calls', 'called_by', 'references', 'referenced_by']))
            .optional()
            .describe('Filter by relation types (default: all)'),
          limit: z.coerce.number().min(1).max(50).default(20).describe('Max results per direction'),
        },
        async ({ chunk_id, direction, relation_types, limit }) => {
          try {
            if (!this.metadataStore) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Symbol graph is not available. The metadata store is not configured.',
                  },
                ],
              };
            }

            const payload = await this.indexer.getChunkById(chunk_id);
            if (!payload) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Chunk not found: ${chunk_id}\n\nThe chunk may have been removed during reindexing. Try searching again.`,
                  },
                ],
              };
            }

            const defSymbols = Array.isArray(payload['defines_symbols'])
              ? (payload['defines_symbols'] as string[])
              : [];

            const wantIncoming = direction === 'incoming' || direction === 'both';
            const wantOutgoing = direction === 'outgoing' || direction === 'both';

            let edgesTo = wantIncoming ? this.metadataStore.getEdgesTo(chunk_id) : [];
            let edgesFrom = wantOutgoing ? this.metadataStore.getEdgesFrom(chunk_id) : [];

            if (relation_types && relation_types.length > 0) {
              const allowed = new Set(relation_types);
              edgesTo = edgesTo.filter((e) => allowed.has(e.relation_type));
              edgesFrom = edgesFrom.filter((e) => allowed.has(e.relation_type));
            }

            edgesTo = edgesTo.slice(0, limit);
            edgesFrom = edgesFrom.slice(0, limit);

            if (edgesTo.length === 0 && edgesFrom.length === 0) {
              const symbolInfo =
                defSymbols.length > 0
                  ? `\n\nDefined symbols: ${defSymbols.join(', ')}`
                  : '\n\nNo symbols defined in this chunk.';
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No usages found for chunk: ${chunk_id}${symbolInfo}\n\nThis may mean the symbols are not used in indexed code, or the project needs reindexing.`,
                  },
                ],
              };
            }

            const project = typeof payload['project'] === 'string' ? payload['project'] : 'unknown';
            const file = typeof payload['file'] === 'string' ? payload['file'] : 'unknown';
            let text = `## Usages of [${project}] ${file}\n\n`;

            // Fetch all chunk payloads in parallel
            const [incomingPayloads, outgoingPayloads] = await Promise.all([
              Promise.all(edgesTo.map((edge) => this.indexer.getChunkById(edge.from_chunk_id))),
              Promise.all(edgesFrom.map((edge) => this.indexer.getChunkById(edge.to_chunk_id))),
            ]);

            // Incoming: chunks that use symbols defined in this chunk
            if (edgesTo.length > 0) {
              // Group by symbol
              const bySymbol = new Map<
                string,
                Array<{ edge: (typeof edgesTo)[0]; payload: Record<string, unknown> | null }>
              >();
              for (let i = 0; i < edgesTo.length; i++) {
                const edge = edgesTo[i]!;
                let list = bySymbol.get(edge.symbol_name);
                if (!list) {
                  list = [];
                  bySymbol.set(edge.symbol_name, list);
                }
                list.push({ edge, payload: incomingPayloads[i] ?? null });
              }

              text += `### Incoming (${edgesTo.length}) — who uses this chunk\n\n`;
              for (const [symbol, entries] of bySymbol) {
                text += `**\`${symbol}\`** (${entries.length})\n`;
                for (const { edge, payload: ep } of entries) {
                  if (ep) {
                    const p = typeof ep['project'] === 'string' ? ep['project'] : 'unknown';
                    const f = typeof ep['file'] === 'string' ? ep['file'] : 'unknown';
                    const sl = typeof ep['startLine'] === 'number' ? ep['startLine'] : 0;
                    const sym = typeof ep['symbol_name'] === 'string' ? ep['symbol_name'] : null;
                    const symInfo = sym ? ` (${sym})` : '';
                    text += `- **[${p}] ${f}:${sl}**${symInfo} — ${edge.relation_type}\n`;
                    text += `  _chunk: ${edge.from_chunk_id}_\n`;
                  } else {
                    text += `- _chunk: ${edge.from_chunk_id}_ — ${edge.relation_type}\n`;
                  }
                }
                text += '\n';
              }
            }

            // Outgoing: symbols this chunk uses that are defined elsewhere
            if (edgesFrom.length > 0) {
              const bySymbol = new Map<
                string,
                Array<{ edge: (typeof edgesFrom)[0]; payload: Record<string, unknown> | null }>
              >();
              for (let i = 0; i < edgesFrom.length; i++) {
                const edge = edgesFrom[i]!;
                let list = bySymbol.get(edge.symbol_name);
                if (!list) {
                  list = [];
                  bySymbol.set(edge.symbol_name, list);
                }
                list.push({ edge, payload: outgoingPayloads[i] ?? null });
              }

              text += `### Outgoing (${edgesFrom.length}) — what this chunk uses\n\n`;
              for (const [symbol, entries] of bySymbol) {
                text += `**\`${symbol}\`** (${entries.length})\n`;
                for (const { edge, payload: ep } of entries) {
                  if (ep) {
                    const p = typeof ep['project'] === 'string' ? ep['project'] : 'unknown';
                    const f = typeof ep['file'] === 'string' ? ep['file'] : 'unknown';
                    const sl = typeof ep['startLine'] === 'number' ? ep['startLine'] : 0;
                    const sym = typeof ep['symbol_name'] === 'string' ? ep['symbol_name'] : null;
                    const symInfo = sym ? ` (${sym})` : '';
                    text += `- **[${p}] ${f}:${sl}**${symInfo} — ${edge.relation_type}\n`;
                    text += `  _chunk: ${edge.to_chunk_id}_\n`;
                  } else {
                    text += `- _chunk: ${edge.to_chunk_id}_ — ${edge.relation_type}\n`;
                  }
                }
                text += '\n';
              }
            }

            return { content: [{ type: 'text' as const, text }] };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to find usages: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Tool: explain_feature ────────────────────────────────────────────────
    if (tools.has('explain_feature'))
      server.tool(
        'explain_feature',
        prompts.tools.explain_feature.description,
        {
          question: z.string().describe('Natural language question about a feature'),
          group: z.string().optional().describe('Specific group or omit for all'),
          project: z.string().default('all').describe('Project name or "all"'),
          limit: z.coerce.number().min(1).max(10).default(5).describe('Max seed chunks'),
        },
        async ({ question, group, project, limit }) => {
          try {
            const groupNames = group ? [group] : this.getGroupNames();

            if (groupNames.length === 0) {
              return {
                content: [
                  { type: 'text' as const, text: 'No groups registered. Index a project first.' },
                ],
              };
            }

            // Search across groups and deduplicate
            const allResults: Array<{
              project: string;
              file: string;
              startLine: number;
              endLine: number;
              score: number;
              hash: string;
              chunk_id: string | null;
              symbol_name: string | null;
              kind: string | null;
              service: string | null;
              bounded_context: string | null;
            }> = [];

            for (const g of groupNames) {
              const response = await this.searcher.expandedSearch(g, question, {
                project,
                limit: limit * 2,
              });
              for (const r of response.results) {
                allResults.push({
                  project: r.project,
                  file: r.file,
                  startLine: r.startLine,
                  endLine: r.endLine,
                  score: r.score,
                  hash: r.hash,
                  chunk_id: r.chunk_id,
                  symbol_name: r.symbol_name,
                  kind: r.kind as string | null,
                  service: r.service,
                  bounded_context: r.bounded_context,
                });
              }
            }

            const seen = new Set<string>();
            const deduped = allResults.filter((r) => {
              if (seen.has(r.hash)) return false;
              seen.add(r.hash);
              return true;
            });
            deduped.sort((a, b) => b.score - a.score);
            const top = deduped.slice(0, limit);

            if (top.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No results found. Make sure the project is indexed.',
                  },
                ],
              };
            }

            // ── Code Locations table ──
            let text = `## Code Locations\n\n`;
            text += '| File | Lines | Symbol | Score | Service | Chunk ID |\n';
            text += '|------|-------|--------|-------|---------|----------|\n';
            for (const r of top) {
              const score = (r.score * 100).toFixed(1);
              const sym = r.symbol_name ? `\`${r.symbol_name}\` (${r.kind ?? 'unknown'})` : '—';
              const svc = r.service ?? '—';
              const cid = r.chunk_id ?? '—';
              text += `| ${r.project}/${r.file} | ${r.startLine}-${r.endLine} | ${sym} | ${score}% | ${svc} | ${cid} |\n`;
            }

            // ── Recent Changes + Related Modules (requires metadataStore) ──
            if (this.metadataStore) {
              const chunkIds = top.map((r) => r.chunk_id).filter((id): id is string => id != null);

              // Parallel fetch: commits, tickets, incoming edges, outgoing edges per chunk
              const [allCommits, allTickets, allEdgesTo, allEdgesFrom] = await Promise.all([
                Promise.all(chunkIds.map((id) => this.metadataStore!.getCommits(id, 5))),
                Promise.all(chunkIds.map((id) => this.metadataStore!.getTickets(id))),
                Promise.all(chunkIds.map((id) => this.metadataStore!.getEdgesTo(id))),
                Promise.all(chunkIds.map((id) => this.metadataStore!.getEdgesFrom(id))),
              ]);

              // ── Recent Changes ──
              // Deduplicate commits by commit_hash, associate chunk locations
              const commitMap = new Map<
                string,
                {
                  committed_at: string;
                  author_email: string;
                  message_summary: string;
                  chunks: string[];
                  tickets: Set<string>;
                }
              >();

              for (let i = 0; i < chunkIds.length; i++) {
                const cid = chunkIds[i]!;
                const commits = allCommits[i]!;
                const tickets = allTickets[i]!;
                const ticketKeys = tickets.map((t) => `${t.ticket_key} (${t.source})`);

                for (const c of commits) {
                  let entry = commitMap.get(c.commit_hash);
                  if (!entry) {
                    entry = {
                      committed_at: c.committed_at,
                      author_email: c.author_email,
                      message_summary: c.message_summary,
                      chunks: [],
                      tickets: new Set(),
                    };
                    commitMap.set(c.commit_hash, entry);
                  }
                  entry.chunks.push(cid);
                  for (const tk of ticketKeys) entry.tickets.add(tk);
                }
              }

              if (commitMap.size > 0) {
                const sortedCommits = Array.from(commitMap.values()).sort((a, b) =>
                  b.committed_at.localeCompare(a.committed_at)
                );

                text += `\n## Recent Changes (${sortedCommits.length} commits)\n\n`;
                for (const c of sortedCommits) {
                  const date = c.committed_at.split('T')[0] ?? c.committed_at;
                  const ticketStr =
                    c.tickets.size > 0 ? ` | Tickets: ${Array.from(c.tickets).join(', ')}` : '';
                  text += `- **${date}** ${c.author_email}: ${c.message_summary}${ticketStr}\n`;
                  text += `  Affected: ${c.chunks.join(', ')}\n`;
                }
              }

              // ── Related Modules ──
              const allIncoming = allEdgesTo.flat();
              const allOutgoing = allEdgesFrom.flat();

              if (allIncoming.length > 0 || allOutgoing.length > 0) {
                // Resolve edge targets to get file/service info
                const edgeChunkIds = new Set<string>();
                for (const e of allIncoming) edgeChunkIds.add(e.from_chunk_id);
                for (const e of allOutgoing) edgeChunkIds.add(e.to_chunk_id);

                const edgeIds = Array.from(edgeChunkIds);
                const edgePayloads = await Promise.all(
                  edgeIds.map((id) => this.indexer.getChunkById(id))
                );
                const edgeLocations = new Map<string, ChunkLocation>();
                for (let i = 0; i < edgeIds.length; i++) {
                  const ep = edgePayloads[i];
                  if (ep) edgeLocations.set(edgeIds[i]!, resolveChunkLocation(ep));
                }

                text += `\n## Related Modules\n`;

                if (allIncoming.length > 0) {
                  // Group by symbol
                  const bySymbol = new Map<
                    string,
                    Array<{ chunkId: string; relation: string; loc: ChunkLocation | undefined }>
                  >();
                  for (const e of allIncoming) {
                    let list = bySymbol.get(e.symbol_name);
                    if (!list) {
                      list = [];
                      bySymbol.set(e.symbol_name, list);
                    }
                    list.push({
                      chunkId: e.from_chunk_id,
                      relation: e.relation_type,
                      loc: edgeLocations.get(e.from_chunk_id),
                    });
                  }

                  text += `\n### Incoming (callers)\n\n`;
                  for (const [symbol, entries] of bySymbol) {
                    text += `**\`${symbol}\`**\n`;
                    for (const { chunkId, relation, loc } of entries) {
                      if (loc) {
                        text += `- [${loc.project}] ${loc.file}:${loc.startLine} — ${relation} _chunk: ${chunkId}_\n`;
                      } else {
                        text += `- _chunk: ${chunkId}_ — ${relation}\n`;
                      }
                    }
                  }
                }

                if (allOutgoing.length > 0) {
                  const bySymbol = new Map<
                    string,
                    Array<{ chunkId: string; relation: string; loc: ChunkLocation | undefined }>
                  >();
                  for (const e of allOutgoing) {
                    let list = bySymbol.get(e.symbol_name);
                    if (!list) {
                      list = [];
                      bySymbol.set(e.symbol_name, list);
                    }
                    list.push({
                      chunkId: e.to_chunk_id,
                      relation: e.relation_type,
                      loc: edgeLocations.get(e.to_chunk_id),
                    });
                  }

                  text += `\n### Outgoing (dependencies)\n\n`;
                  for (const [symbol, entries] of bySymbol) {
                    text += `**\`${symbol}\`**\n`;
                    for (const { chunkId, relation, loc } of entries) {
                      if (loc) {
                        text += `- [${loc.project}] ${loc.file}:${loc.startLine} — ${relation} _chunk: ${chunkId}_\n`;
                      } else {
                        text += `- _chunk: ${chunkId}_ — ${relation}\n`;
                      }
                    }
                  }
                }
              }
            }

            return { content: [{ type: 'text' as const, text }] };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Feature analysis failed: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Tool: recent_changes ─────────────────────────────────────────────────
    if (tools.has('recent_changes'))
      server.tool(
        'recent_changes',
        prompts.tools.recent_changes.description,
        {
          question: z.string().describe('Semantic search query'),
          since: z.string().optional().describe('ISO 8601 date filter (e.g. "2024-01-01")'),
          group: z.string().optional().describe('Specific group or omit for all'),
          project: z.string().default('all').describe('Project name or "all"'),
          limit: z.coerce.number().min(1).max(20).default(10).describe('Max seed chunks'),
        },
        async ({ question, since, group, project, limit }) => {
          try {
            const groupNames = group ? [group] : this.getGroupNames();

            if (groupNames.length === 0) {
              return {
                content: [
                  { type: 'text' as const, text: 'No groups registered. Index a project first.' },
                ],
              };
            }

            // Build Qdrant filter for date range
            const additionalFilter: { must: Array<Record<string, unknown>> } = { must: [] };
            if (since) {
              additionalFilter.must.push({
                key: 'last_commit_at',
                range: { gte: since },
              });
            }

            // Search with filter across groups
            const allResults: Array<{
              project: string;
              file: string;
              startLine: number;
              endLine: number;
              score: number;
              hash: string;
              chunk_id: string | null;
              symbol_name: string | null;
              kind: string | null;
              last_commit_at: string | null;
              service: string | null;
            }> = [];

            for (const g of groupNames) {
              const response = await this.searcher.searchWithFilter(g, question, additionalFilter, {
                project,
                limit: limit * 2,
              });
              for (const r of response.results) {
                allResults.push({
                  project: r.project,
                  file: r.file,
                  startLine: r.startLine,
                  endLine: r.endLine,
                  score: r.score,
                  hash: r.hash,
                  chunk_id: r.chunk_id,
                  symbol_name: r.symbol_name,
                  kind: r.kind as string | null,
                  last_commit_at: r.last_commit_at,
                  service: r.service,
                });
              }
            }

            const seen = new Set<string>();
            const deduped = allResults.filter((r) => {
              if (seen.has(r.hash)) return false;
              seen.add(r.hash);
              return true;
            });
            deduped.sort((a, b) => b.score - a.score);
            const top = deduped.slice(0, limit);

            if (top.length === 0) {
              const sinceNote = since ? ` modified after ${since}` : '';
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No results found for "${question}"${sinceNote}. Make sure the project is indexed and has git metadata.`,
                  },
                ],
              };
            }

            let text = '';

            // ── Timeline (requires metadataStore) ──
            if (this.metadataStore) {
              const chunkIds = top.map((r) => r.chunk_id).filter((id): id is string => id != null);

              const [allCommits, allTickets] = await Promise.all([
                Promise.all(chunkIds.map((id) => this.metadataStore!.getCommits(id, 10))),
                Promise.all(chunkIds.map((id) => this.metadataStore!.getTickets(id))),
              ]);

              // Build chunk_id → location map from search results
              const chunkLocMap = new Map<
                string,
                { project: string; file: string; startLine: number }
              >();
              for (const r of top) {
                if (r.chunk_id) {
                  chunkLocMap.set(r.chunk_id, {
                    project: r.project,
                    file: r.file,
                    startLine: r.startLine,
                  });
                }
              }

              // Collect all commits, deduplicate by hash, associate chunks + tickets
              const commitMap = new Map<
                string,
                {
                  committed_at: string;
                  author_email: string;
                  message_summary: string;
                  chunks: string[];
                  tickets: Set<string>;
                }
              >();

              for (let i = 0; i < chunkIds.length; i++) {
                const cid = chunkIds[i]!;
                const commits = allCommits[i]!;
                const tickets = allTickets[i]!;
                const ticketKeys = tickets.map((t) => `${t.ticket_key} (${t.source})`);

                for (const c of commits) {
                  let entry = commitMap.get(c.commit_hash);
                  if (!entry) {
                    entry = {
                      committed_at: c.committed_at,
                      author_email: c.author_email,
                      message_summary: c.message_summary,
                      chunks: [],
                      tickets: new Set(),
                    };
                    commitMap.set(c.commit_hash, entry);
                  }
                  if (!entry.chunks.includes(cid)) entry.chunks.push(cid);
                  for (const tk of ticketKeys) entry.tickets.add(tk);
                }
              }

              if (commitMap.size > 0) {
                const sortedCommits = Array.from(commitMap.values()).sort((a, b) =>
                  b.committed_at.localeCompare(a.committed_at)
                );

                // Group by date
                const byDate = new Map<string, typeof sortedCommits>();
                for (const c of sortedCommits) {
                  const date = c.committed_at.split('T')[0] ?? c.committed_at;
                  let list = byDate.get(date);
                  if (!list) {
                    list = [];
                    byDate.set(date, list);
                  }
                  list.push(c);
                }

                text += `## Timeline\n\n`;
                for (const [date, commits] of byDate) {
                  text += `### ${date}\n\n`;
                  for (const c of commits) {
                    const ticketStr =
                      c.tickets.size > 0 ? ` | Tickets: ${Array.from(c.tickets).join(', ')}` : '';
                    text += `- **${c.author_email}**: ${c.message_summary}${ticketStr}\n`;
                    for (const cid of c.chunks) {
                      const loc = chunkLocMap.get(cid);
                      if (loc) {
                        text += `  - ${loc.project}/${loc.file}:${loc.startLine} _chunk: ${cid}_\n`;
                      } else {
                        text += `  - _chunk: ${cid}_\n`;
                      }
                    }
                  }
                  text += '\n';
                }
              }
            }

            // ── Code Locations Summary ──
            text += `## Code Locations Summary\n\n`;
            text += '| File | Lines | Score | Last Changed | Chunk ID |\n';
            text += '|------|-------|-------|-------------|----------|\n';
            for (const r of top) {
              const score = (r.score * 100).toFixed(1);
              const lastChanged = r.last_commit_at
                ? (r.last_commit_at.split('T')[0] ?? r.last_commit_at)
                : '—';
              const cid = r.chunk_id ?? '—';
              text += `| ${r.project}/${r.file} | ${r.startLine}-${r.endLine} | ${score}% | ${lastChanged} | ${cid} |\n`;
            }

            return { content: [{ type: 'text' as const, text }] };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Recent changes search failed: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Tool: impact_analysis ────────────────────────────────────────────────
    if (tools.has('impact_analysis'))
      server.tool(
        'impact_analysis',
        prompts.tools.impact_analysis.description,
        {
          question: z.string().describe('Natural language query about code to analyze'),
          group: z.string().optional().describe('Specific group or omit for all'),
          project: z.string().default('all').describe('Project name or "all"'),
          limit: z.coerce.number().min(1).max(10).default(5).describe('Max seed chunks'),
          max_hops: z.coerce
            .number()
            .min(1)
            .max(2)
            .default(1)
            .describe('Graph traversal depth (1-2)'),
        },
        async ({ question, group, project, limit, max_hops }) => {
          try {
            const groupNames = group ? [group] : this.getGroupNames();

            if (groupNames.length === 0) {
              return {
                content: [
                  { type: 'text' as const, text: 'No groups registered. Index a project first.' },
                ],
              };
            }

            // Search across groups and deduplicate
            const allResults: Array<{
              project: string;
              file: string;
              startLine: number;
              endLine: number;
              score: number;
              hash: string;
              chunk_id: string | null;
              symbol_name: string | null;
              kind: string | null;
              service: string | null;
              bounded_context: string | null;
            }> = [];

            for (const g of groupNames) {
              const response = await this.searcher.expandedSearch(g, question, {
                project,
                limit: limit * 2,
              });
              for (const r of response.results) {
                allResults.push({
                  project: r.project,
                  file: r.file,
                  startLine: r.startLine,
                  endLine: r.endLine,
                  score: r.score,
                  hash: r.hash,
                  chunk_id: r.chunk_id,
                  symbol_name: r.symbol_name,
                  kind: r.kind as string | null,
                  service: r.service,
                  bounded_context: r.bounded_context,
                });
              }
            }

            const seen = new Set<string>();
            const deduped = allResults.filter((r) => {
              if (seen.has(r.hash)) return false;
              seen.add(r.hash);
              return true;
            });
            deduped.sort((a, b) => b.score - a.score);
            const seeds = deduped.slice(0, limit);

            if (seeds.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No results found. Make sure the project is indexed.',
                  },
                ],
              };
            }

            // ── Seed Chunks table ──
            let text = `## Seed Chunks\n\n`;
            text += '| File | Lines | Symbol | Score | Service | Chunk ID |\n';
            text += '|------|-------|--------|-------|---------|----------|\n';
            for (const r of seeds) {
              const score = (r.score * 100).toFixed(1);
              const sym = r.symbol_name ? `\`${r.symbol_name}\` (${r.kind ?? 'unknown'})` : '—';
              const svc = r.service ?? '—';
              const cid = r.chunk_id ?? '—';
              text += `| ${r.project}/${r.file} | ${r.startLine}-${r.endLine} | ${sym} | ${score}% | ${svc} | ${cid} |\n`;
            }

            if (!this.metadataStore) {
              text += '\n_Symbol graph not available. Only seed chunks shown._\n';
              return { content: [{ type: 'text' as const, text }] };
            }

            const seedIds = new Set(
              seeds.map((r) => r.chunk_id).filter((id): id is string => id != null)
            );

            // Collect all edges and discovered chunk IDs per hop
            const allEdges: Array<{
              from: string;
              to: string;
              relation: string;
              symbol: string;
            }> = [];
            const discoveredByHop = new Map<string, number>(); // chunkId -> hop level

            // ── Hop 1 ──
            const seedIdArr = Array.from(seedIds);
            const [hop1EdgesTo, hop1EdgesFrom] = await Promise.all([
              Promise.all(seedIdArr.map((id) => this.metadataStore!.getEdgesTo(id))),
              Promise.all(seedIdArr.map((id) => this.metadataStore!.getEdgesFrom(id))),
            ]);

            for (const edges of hop1EdgesTo.flat()) {
              allEdges.push({
                from: edges.from_chunk_id,
                to: edges.to_chunk_id,
                relation: edges.relation_type,
                symbol: edges.symbol_name,
              });
              if (!seedIds.has(edges.from_chunk_id) && !discoveredByHop.has(edges.from_chunk_id)) {
                discoveredByHop.set(edges.from_chunk_id, 1);
              }
            }
            for (const edges of hop1EdgesFrom.flat()) {
              allEdges.push({
                from: edges.from_chunk_id,
                to: edges.to_chunk_id,
                relation: edges.relation_type,
                symbol: edges.symbol_name,
              });
              if (!seedIds.has(edges.to_chunk_id) && !discoveredByHop.has(edges.to_chunk_id)) {
                discoveredByHop.set(edges.to_chunk_id, 1);
              }
            }

            // Cap hop-1 discoveries
            const hop1Ids = Array.from(discoveredByHop.keys()).slice(0, 50);

            // ── Hop 2 (if requested) ──
            if (max_hops >= 2 && hop1Ids.length > 0) {
              const [hop2EdgesTo, hop2EdgesFrom] = await Promise.all([
                Promise.all(hop1Ids.map((id) => this.metadataStore!.getEdgesTo(id))),
                Promise.all(hop1Ids.map((id) => this.metadataStore!.getEdgesFrom(id))),
              ]);

              let hop2Count = 0;
              for (const edges of hop2EdgesTo.flat()) {
                allEdges.push({
                  from: edges.from_chunk_id,
                  to: edges.to_chunk_id,
                  relation: edges.relation_type,
                  symbol: edges.symbol_name,
                });
                if (
                  !seedIds.has(edges.from_chunk_id) &&
                  !discoveredByHop.has(edges.from_chunk_id) &&
                  hop2Count < 50
                ) {
                  discoveredByHop.set(edges.from_chunk_id, 2);
                  hop2Count++;
                }
              }
              for (const edges of hop2EdgesFrom.flat()) {
                allEdges.push({
                  from: edges.from_chunk_id,
                  to: edges.to_chunk_id,
                  relation: edges.relation_type,
                  symbol: edges.symbol_name,
                });
                if (
                  !seedIds.has(edges.to_chunk_id) &&
                  !discoveredByHop.has(edges.to_chunk_id) &&
                  hop2Count < 50
                ) {
                  discoveredByHop.set(edges.to_chunk_id, 2);
                  hop2Count++;
                }
              }
            }

            // Resolve all discovered chunks to get location info
            const discoveredIds = Array.from(discoveredByHop.keys());
            const discoveredPayloads = await Promise.all(
              discoveredIds.map((id) => this.indexer.getChunkById(id))
            );
            const discoveredLocations = new Map<string, ChunkLocation>();
            for (let i = 0; i < discoveredIds.length; i++) {
              const ep = discoveredPayloads[i];
              if (ep) discoveredLocations.set(discoveredIds[i]!, resolveChunkLocation(ep));
            }

            // ── Impact by Service/Context ──
            if (discoveredIds.length > 0) {
              // Group by service or bounded_context
              const byService = new Map<
                string,
                Array<{ chunkId: string; hop: number; loc: ChunkLocation }>
              >();

              for (const [chunkId, hop] of discoveredByHop) {
                const loc = discoveredLocations.get(chunkId);
                if (!loc) continue;
                const key = loc.service ?? loc.boundedContext ?? 'unknown';
                let list = byService.get(key);
                if (!list) {
                  list = [];
                  byService.set(key, list);
                }
                list.push({ chunkId, hop, loc });
              }

              text += `\n## Impact by Service (${discoveredIds.length} connected chunks)\n`;

              for (const [service, entries] of byService) {
                text += `\n### ${service}\n\n`;
                for (const { chunkId, hop, loc } of entries) {
                  const sym = loc.symbolName ? ` \`${loc.symbolName}\`` : '';
                  text += `- [hop ${hop}] ${loc.project}/${loc.file}:${loc.startLine}${sym} _chunk: ${chunkId}_\n`;
                }
              }
            }

            // ── Dependency Edges table ──
            if (allEdges.length > 0) {
              // Deduplicate edges
              const edgeSet = new Set<string>();
              const uniqueEdges = allEdges.filter((e) => {
                const key = `${e.from}→${e.to}→${e.symbol}`;
                if (edgeSet.has(key)) return false;
                edgeSet.add(key);
                return true;
              });

              text += `\n## Dependency Edges (${uniqueEdges.length})\n\n`;
              text += '| From | To | Relation | Symbol |\n';
              text += '|------|----|----------|--------|\n';
              for (const e of uniqueEdges.slice(0, 50)) {
                text += `| ${e.from} | ${e.to} | ${e.relation} | \`${e.symbol}\` |\n`;
              }
              if (uniqueEdges.length > 50) {
                text += `\n_Showing 50 of ${uniqueEdges.length} edges._\n`;
              }
            }

            return { content: [{ type: 'text' as const, text }] };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Impact analysis failed: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    return server;
  }

  // ── SSE transport (Cursor) ──────────────────────────────────────────────

  private async handleSSE(_req: Request, res: Response, mode: McpMode): Promise<void> {
    try {
      const messagesPath = mode === 'coding' ? '/messages' : '/support/messages';
      const transport = new SSEServerTransport(messagesPath, res);
      const sessionId = transport.sessionId;

      const now = Date.now();
      this.transports[sessionId] = { transport, created: now, lastActivity: now };
      this.sessionModes.set(sessionId, mode);
      res.on('close', () => this.cleanupSession(sessionId));

      const server = this.getMcpServer(sessionId, mode);
      await server.connect(transport);
    } catch (err) {
      console.error('[mcp] SSE error:', err);
      if (!res.headersSent) res.status(500).send('Internal error');
    }
  }

  private async handleMessages(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.query.sessionId as string | undefined;
      const entry = sessionId ? this.transports[sessionId] : undefined;

      if (!entry) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'No transport for sessionId' },
          id: null,
        });
        return;
      }

      entry.lastActivity = Date.now();
      const transport = entry.transport;
      if ('handlePostMessage' in transport) {
        await transport.handlePostMessage(req, res, req.body);
      }
    } catch (err) {
      console.error('[mcp] Messages error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: (err as Error).message },
          id: null,
        });
      }
    }
  }

  // ── Streamable HTTP transport (Claude Code) ─────────────────────────────

  private async handleStreamableHTTP(req: Request, res: Response, mode: McpMode): Promise<void> {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transportEntry = sessionId ? this.transports[sessionId] : undefined;

      if (transportEntry) {
        transportEntry.lastActivity = Date.now();
        const t = transportEntry.transport;
        if ('handleRequest' in t) {
          await t.handleRequest(req, res, req.body);
        }
        return;
      }

      if (!sessionId && req.method === 'POST' && this.isInitializeRequest(req.body)) {
        const lockKey = (req.socket?.remoteAddress ?? req.ip) || 'unknown';

        if (this.sessionCreationLocks.has(lockKey)) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const retrySessionId = req.headers['mcp-session-id'] as string | undefined;
          transportEntry = retrySessionId ? this.transports[retrySessionId] : undefined;
          if (transportEntry) {
            const t = transportEntry.transport;
            if ('handleRequest' in t) {
              await t.handleRequest(req, res, req.body);
            }
            return;
          }
        }

        this.sessionCreationLocks.add(lockKey);

        try {
          let resolvedSessionId: string | null = null;
          const server = this.createMcpServer(mode);

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => uuidv7(),
            onsessioninitialized: (sid) => {
              resolvedSessionId = sid;
              const now = Date.now();
              this.transports[sid] = { transport, created: now, lastActivity: now };
              this.servers.set(sid, server);
              this.sessionModes.set(sid, mode);
            },
          });

          transport.onclose = () => {
            if (resolvedSessionId) this.cleanupSession(resolvedSessionId);
          };

          await server.connect(transport);
          await (transport as StreamableHTTPServerTransport).handleRequest(req, res, req.body);
        } finally {
          this.sessionCreationLocks.delete(lockKey);
        }
        return;
      }

      if (sessionId && (req.method === 'POST' || req.method === 'GET')) {
        // Session ID was provided but not found — expired or server restarted.
        // Instead of returning 404, transparently recreate the session with the same ID.
        // This allows clients to survive server restarts without re-initializing.
        console.log(`[mcp] Recreating lost session ${sessionId}`);

        try {
          const server = this.createMcpServer(mode);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId,
          });

          // Force-initialize the underlying transport so it accepts non-initialize requests.
          // The SDK's _webStandardTransport tracks initialization state internally.
          const inner = (transport as unknown as { _webStandardTransport: Record<string, unknown> })
            ._webStandardTransport;
          inner.sessionId = sessionId;
          inner._initialized = true;

          const now = Date.now();
          this.transports[sessionId] = { transport, created: now, lastActivity: now };
          this.servers.set(sessionId, server);
          this.sessionModes.set(sessionId, mode);

          transport.onclose = () => this.cleanupSession(sessionId);

          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          console.error(`[mcp] Failed to recreate session ${sessionId}:`, err);
          res.status(404).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Session not found. Client should start a new session.',
            },
            id: null,
          });
        }
      } else if (sessionId) {
        // DELETE or other methods with unknown session
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Session not found. Client should start a new session.',
          },
          id: null,
        });
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID or initialize required',
          },
          id: null,
        });
      }
    } catch (err) {
      console.error('[mcp] Streamable HTTP error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: (err as Error).message },
          id: null,
        });
      }
    }
  }
}
