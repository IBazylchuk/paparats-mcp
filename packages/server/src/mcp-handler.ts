import { v7 as uuidv7 } from 'uuid';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Searcher } from './searcher.js';
import type { Indexer } from './indexer.js';
import type { ProjectConfig } from './types.js';

export interface McpHandlerConfig {
  searcher: Searcher;
  indexer: Indexer;
  /** Callback to get currently registered projects grouped by group name */
  getProjects: () => Map<string, ProjectConfig[]>;
  /** Callback to get all known group names */
  getGroupNames: () => string[];
}

type TransportEntry = {
  transport: SSEServerTransport | StreamableHTTPServerTransport;
  created: number;
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
  private transports: Record<string, TransportEntry> = {};
  private servers = new Map<string, McpServer>();
  private reindexJobs = new Map<string, ReindexJob>();
  private sessionCreationLocks = new Set<string>();

  private readonly SESSION_TIMEOUT_MS = 1000 * 60 * 30; // 30 min for local use
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: McpHandlerConfig) {
    this.searcher = config.searcher;
    this.indexer = config.indexer;
    this.getProjects = config.getProjects;
    this.getGroupNames = config.getGroupNames;

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
      if (now - entry.created > this.SESSION_TIMEOUT_MS) {
        this.cleanupSession(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[mcp] Cleaned up ${cleaned} expired sessions`);
    }
  }

  private isInitializeRequest(v: unknown): v is { method: 'initialize'; params: unknown } {
    if (v == null || typeof v !== 'object') return false;
    const obj = v as Record<string, unknown>;
    return obj.method === 'initialize' && obj.params != null;
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'paparats-mcp', version: '0.1.0' },
      {
        instructions:
          'Semantic code search across workspace projects. Use search_code for exploratory questions.',
      }
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

        sections.push(
          '## Search Capabilities',
          '',
          'Use `search_code` tool to find relevant code across all projects.',
          'This is MORE EFFICIENT than loading full files.',
          '',
          'Example queries:',
          '- "authentication flow"',
          '- "GraphQL mutations for user"',
          '- "AWS infrastructure setup"',
          '',
          'Always search before answering code questions.'
        );

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
      `Semantic code search across all indexed projects.

USE THIS when user asks about code location, implementation, or "how X works".

WHY: Returns only relevant chunks (50-90% fewer tokens vs full files). Searches by meaning, not keywords.

WORKFLOW: Search first → understand context → load specific files only if needed.

Examples: "auth flow", "GraphQL mutations", "error handling patterns"`,
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
          }> = [];

          for (const g of groupNames) {
            const response = await this.searcher.search(g, query, {
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
              return `**[${r.project}] ${r.file}:${r.startLine}** (${score}%)\n\`\`\`${r.language}\n${r.content}\n\`\`\``;
            })
            .join('\n\n---\n\n');

          return { content: [{ type: 'text' as const, text: formatted }] };
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
    server.tool(
      'health_check',
      `Check indexing status: number of indexed chunks per group and any running reindex jobs.

Use to verify projects are indexed before searching or debugging empty results.`,
      {},
      async () => {
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
      }
    );

    // ── Tool: reindex ───────────────────────────────────────────────────────
    server.tool(
      'reindex',
      `Trigger full reindex of a group or all groups. Runs in background.

Returns job ID to track progress via health_check. Use after adding new files or changing project config.`,
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

      this.transports[sessionId] = { transport, created: Date.now() };
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
              this.transports[sid] = { transport, created: Date.now() };
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

      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID or initialize required',
        },
        id: null,
      });
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
