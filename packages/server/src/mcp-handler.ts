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

function confidenceTier(score: number): string {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) return 'high confidence';
  if (score >= LOW_CONFIDENCE_THRESHOLD) return 'partial match';
  return 'low confidence';
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

export class McpHandler {
  private searcher: Searcher;
  private indexer: Indexer;
  private getProjects: () => Map<string, ProjectConfig[]>;
  private getGroupNames: () => string[];
  private metadataStore: MetadataStore | null;
  private transports: Record<string, TransportEntry> = {};
  private servers = new Map<string, McpServer>();
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

    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000); // Every 5 min
  }

  /** Mount all MCP routes on the Express app */
  mount(app: Express): void {
    app.get('/sse', (req, res) => this.handleSSE(req, res));
    app.post('/messages', (req, res) => this.handleMessages(req, res));
    app.all('/mcp', (req, res) => this.handleStreamableHTTP(req, res));
  }

  /** Graceful shutdown: stop cleanup interval and remove all sessions */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const sessionId of Object.keys(this.transports)) {
      this.cleanupSession(sessionId);
    }
    this.reindexJobs.clear();
  }

  private getMcpServer(sessionId: string): McpServer {
    let server = this.servers.get(sessionId);
    if (!server) {
      server = this.createMcpServer();
      this.servers.set(sessionId, server);
    }
    return server;
  }

  private cleanupSession(sessionId: string): void {
    delete this.transports[sessionId];
    this.servers.delete(sessionId);
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

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'paparats-mcp', version: '0.1.2' },
      { instructions: prompts.serverInstructions }
    );

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
    server.tool(
      'search_code',
      prompts.tools.search_code.description,
      {
        query: z.string().describe('Natural language query or code snippet'),
        group: z.string().optional().describe('Specific group or omit for all'),
        project: z.string().default('all').describe('Project name or "all"'),
        limit: z.number().min(1).max(20).default(5).describe('Max results'),
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
              const tier = confidenceTier(r.score);
              const symbolInfo = r.symbol_name ? ` — ${r.kind ?? 'unknown'}: ${r.symbol_name}` : '';
              const chunkRef = r.chunk_id ? `\n_chunk: ${r.chunk_id}_` : '';
              return `**[${r.project}] ${r.file}:${r.startLine}** (${score}% — ${tier}${symbolInfo})${chunkRef}\n\`\`\`${sanitizeLang(r.language)}\n${r.content}\n\`\`\``;
            })
            .join('\n\n---\n\n');

          const highCount = top.filter((r) => r.score >= HIGH_CONFIDENCE_THRESHOLD).length;
          const lowCount = top.filter((r) => r.score < LOW_CONFIDENCE_THRESHOLD).length;
          const bestScore = top[0]?.score ?? 0;

          let guidance = '';
          if (bestScore < LOW_CONFIDENCE_THRESHOLD) {
            guidance =
              '> **Low confidence results.** Use grep or file reading to find what you need.\n\n';
          } else if (bestScore < HIGH_CONFIDENCE_THRESHOLD) {
            guidance =
              '> **Partial match results.** Supplement with grep or file reading for better coverage.\n\n';
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
    server.tool(
      'get_chunk',
      prompts.tools.get_chunk.description,
      {
        chunk_id: z.string().describe('Chunk ID from search_code results'),
        radius_lines: z
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
          const service = payload['service'] as string | null;
          const boundedContext = payload['bounded_context'] as string | null;
          const tags = (payload['tags'] as string[]) ?? [];

          let text = '';

          // Metadata header
          text += `**[${project}] ${file}:${startLine}-${endLine}**\n`;
          if (symbolName) text += `Symbol: \`${symbolName}\` (${kind ?? 'unknown'})\n`;
          if (service) text += `Service: ${service}\n`;
          if (boundedContext) text += `Context: ${boundedContext}\n`;
          if (tags.length > 0) text += `Tags: ${tags.join(', ')}\n`;
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
    server.tool(
      'get_chunk_meta',
      prompts.tools.get_chunk_meta.description,
      {
        chunk_id: z.string().describe('Chunk ID from search_code results'),
        commit_limit: z
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
          const language = typeof payload['language'] === 'string' ? payload['language'] : 'text';
          const startLine = typeof payload['startLine'] === 'number' ? payload['startLine'] : 0;
          const endLine = typeof payload['endLine'] === 'number' ? payload['endLine'] : 0;
          const content = typeof payload['content'] === 'string' ? payload['content'] : '';
          const symbolName =
            typeof payload['symbol_name'] === 'string' ? payload['symbol_name'] : null;
          const kind = typeof payload['kind'] === 'string' ? payload['kind'] : null;
          const service = typeof payload['service'] === 'string' ? payload['service'] : null;
          const boundedContext =
            typeof payload['bounded_context'] === 'string' ? payload['bounded_context'] : null;
          const tags = Array.isArray(payload['tags']) ? (payload['tags'] as string[]) : [];

          let text = '';

          // Metadata header
          text += `**[${project}] ${file}:${startLine}-${endLine}**\n`;
          if (symbolName) text += `Symbol: \`${symbolName}\` (${kind ?? 'unknown'})\n`;
          if (service) text += `Service: ${service}\n`;
          if (boundedContext) text += `Context: ${boundedContext}\n`;
          if (tags.length > 0) text += `Tags: ${tags.join(', ')}\n`;
          text += '\n';

          // Code block
          text += `\`\`\`${sanitizeLang(language)}\n${content}\n\`\`\`\n\n`;

          // Commits table
          const commits = this.metadataStore.getCommits(chunk_id, commit_limit);
          if (commits.length > 0) {
            text += `### Recent Commits (${commits.length})\n\n`;
            text += '| Date | Author | Message | Hash |\n';
            text += '|------|--------|---------|------|\n';
            for (const c of commits) {
              const date = c.committed_at.split('T')[0] ?? c.committed_at;
              const shortHash = c.commit_hash.slice(0, 7);
              text += `| ${date} | ${c.author_email} | ${c.message_summary} | ${shortHash} |\n`;
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
        limit: z.number().min(1).max(20).default(5).describe('Max results'),
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
              const tier = confidenceTier(r.score);
              const symbolInfo = r.symbol_name ? ` — ${r.kind ?? 'unknown'}: ${r.symbol_name}` : '';
              const chunkRef = r.chunk_id ? `\n_chunk: ${r.chunk_id}_` : '';
              return `**[${r.project}] ${r.file}:${r.startLine}** (${score}% — ${tier}${symbolInfo})${chunkRef}\n\`\`\`${sanitizeLang(r.language)}\n${r.content}\n\`\`\``;
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

    return server;
  }

  // ── SSE transport (Cursor) ──────────────────────────────────────────────

  private async handleSSE(_req: Request, res: Response): Promise<void> {
    try {
      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;

      const now = Date.now();
      this.transports[sessionId] = { transport, created: now, lastActivity: now };
      res.on('close', () => this.cleanupSession(sessionId));

      const server = this.getMcpServer(sessionId);
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

  private async handleStreamableHTTP(req: Request, res: Response): Promise<void> {
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
          const server = this.createMcpServer();

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => uuidv7(),
            onsessioninitialized: (sid) => {
              resolvedSessionId = sid;
              const now = Date.now();
              this.transports[sid] = { transport, created: now, lastActivity: now };
              this.servers.set(sid, server);
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
          const server = this.createMcpServer();
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
