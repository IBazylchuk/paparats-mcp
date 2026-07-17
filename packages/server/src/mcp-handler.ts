import { createRequire } from 'node:module';
import { v7 as uuidv7 } from 'uuid';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json') as { version: string };
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Searcher } from './searcher.js';
import type { Indexer } from './indexer.js';
import { parseChunkId } from './indexer.js';
import type { MetadataStore } from './metadata-db.js';
import type { ProjectConfig } from './types.js';
import {
  prompts,
  buildProjectOverviewSections,
  buildWorkflowArgsSchema,
  interpolateWorkflowMessage,
} from './prompts/index.js';
import type { Telemetry } from './telemetry/facade.js';
import { tctx } from './telemetry/context.js';
import type { AnalyticsStore } from './telemetry/analytics-store.js';
import {
  tokenSavingsReport,
  topQueries,
  slowestSearches,
  crossProjectShare,
  retryRate,
  failedChunks,
} from './telemetry/queries.js';
import { ArchStore } from './arch/store.js';
import {
  buildArchContextWithVector,
  DEFAULT_MIN_SCORE,
  LOW_CONFIDENCE_HINT,
} from './arch/context.js';
import type { ArchContextResult, ArchWriteResult } from './arch/types.js';
import { type MetricsRegistry, NoOpMetrics } from './metrics.js';

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

/**
 * Cards older than this are flagged with a visible "stale" marker in
 * `arch_context` output. Matches the 90-day threshold the prompts already
 * mention — having a visual prefix means the agent/human can't miss it.
 */
export const STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Returns true when `updatedAt` is older than {@link STALE_THRESHOLD_MS}.
 * Returns false for missing / non-finite timestamps — "unknown age" is not
 * the same as "known to be stale".
 */
export function isStale(updatedAt: number | undefined): boolean {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return false;
  return Date.now() - updatedAt > STALE_THRESHOLD_MS;
}

/**
 * `arch_list` round-trips cursors through the tool surface as strings. When
 * Qdrant returns a structured point id (rare in our UUIDv7 collection but
 * supported by the client), we JSON-encode it for the response; this helper
 * decodes the next-call input. Returns null on parse failure or non-object
 * payloads so the caller can fall back to treating the input as a raw string.
 */
function tryParseObjectOffset(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Render a unix-ms timestamp as a short "updated N units ago" label.
 * Coarse on purpose — the agent's decision is "fresh enough vs. potentially stale",
 * not a precise duration.
 */
function formatAge(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 'updated ?';
  const diffMs = Date.now() - ts;
  if (diffMs < 60 * 1000) return 'updated just now';
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `updated ${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `updated ${months}mo ago`;
  return `updated ${Math.floor(months / 12)}y ago`;
}

/**
 * Render an arch_record_* result as an explicit, agent-actionable message.
 * The `status` field is what tells the agent what to do next:
 *  - `created` / `updated` — the new card landed, nothing more to do.
 *  - `duplicate`           — for lessons we already bumped updatedAt; for
 *                            decisions the caller should ask the user why
 *                            they didn't discover the existing one first.
 *  - `similar`             — nothing was written; the caller decides between
 *                            "update the existing card" (re-call with the
 *                            same key) and "replace it" (decision: pass
 *                            `supersedes`; lesson: refine and re-call).
 */
function formatWriteResult(
  kind: 'decision' | 'lesson',
  label: string,
  result: ArchWriteResult
): string {
  const id = result.id;
  const sim = result.similarity !== undefined ? ` similarity=${result.similarity.toFixed(2)}` : '';
  const matched = result.matchedLabel ? ` matched="${result.matchedLabel}"` : '';
  switch (result.status) {
    case 'created':
      return `Recorded ${kind} "${label}" (id=${id}).`;
    case 'updated':
      // Lesson duplicates land here — the existing card's updatedAt was bumped.
      return (
        `Found a duplicate ${kind} (id=${id}${matched}${sim}). Bumped updatedAt instead of writing a new card. ` +
        `If your wording was meant to refine the existing lesson, refine the existing one rather than retrying.`
      );
    case 'duplicate':
      return (
        `A ${kind} that is nearly identical already exists (id=${id}${matched}${sim}). ` +
        `Nothing was written. Ask the user: why did arch_context not surface this earlier? ` +
        `Then either skip this write or refine the wording so it adds new information.`
      );
    case 'similar':
      return (
        `A similar ${kind} already exists (id=${id}${matched}${sim}). Nothing was written. ` +
        (kind === 'decision'
          ? 'If you intend to replace it, re-call with `supersedes` set to that id. Otherwise sharpen the wording so the similarity drops.'
          : 'Decide whether to refine the existing lesson or write a clearly distinct one — and re-call accordingly.')
      );
  }
}

export interface McpHandlerConfig {
  searcher: Searcher;
  indexer: Indexer;
  /** Callback to get currently registered projects grouped by group name */
  getProjects: () => Map<string, ProjectConfig[]>;
  /** Callback to get all known group names */
  getGroupNames: () => string[];
  /** Callback to remove a project from the in-memory registry */
  removeProject?: (group: string, projectName: string) => void;
  /** Callback to refresh group list from Qdrant (called on session init) */
  syncGroups?: () => Promise<void>;
  /** Optional metadata store for git history tools */
  metadataStore?: MetadataStore;
  /** Optional telemetry façade */
  telemetry?: Telemetry;
  /** Optional analytics store backing the analytics MCP tools */
  analytics?: AnalyticsStore;
  /** Optional arch-layer store. When unset, arch_* tools are skipped at registration time. */
  archStore?: ArchStore;
  /** Optional metrics registry. NoOp by default — see metrics.ts. */
  metrics?: MetricsRegistry;
}

type TransportEntry = {
  transport: SSEServerTransport | StreamableHTTPServerTransport;
  created: number;
  lastActivity: number;
};

export type McpMode = 'coding' | 'support';

/**
 * Pick the user-visible text when `arch_context` returns no sections.
 *
 * Two distinct empty states from `arch/context.ts`:
 *   - `LOW_CONFIDENCE_HINT` — cards exist, just nothing above min_score.
 *     Neutral text, safe in both modes.
 *   - `INIT_HINT` — no cards in the group at all. The default wording names
 *     `arch_record_component`, which support mode can't reach — swap to a
 *     support-appropriate alternative there.
 *
 * Identity compare against `LOW_CONFIDENCE_HINT` (not regex on the text) so
 * the routing doesn't silently drift if the hint wording changes.
 */
export function pickArchContextEmptyText(lastHint: string | null, mode: McpMode): string {
  if (lastHint === LOW_CONFIDENCE_HINT) return LOW_CONFIDENCE_HINT;
  if (mode === 'support') {
    return (
      'No architectural memory recorded yet for this group. Ask whoever ' +
      'maintains the codebase to bootstrap it from coding mode.'
    );
  }
  return (
    lastHint ??
    'No architectural memory recorded yet. Ask the user if you ' +
      'should initialise the arch layer: identify 8-20 components by ' +
      'domain boundaries and write each via arch_record_component.'
  );
}

/**
 * Strip control characters (including ANSI escape introducers and zero-width
 * code points) from arch-card text before it lands in MCP output. Arch cards
 * are authored by other agents — possibly from a different conversation, or
 * by a non-`paparats-mcp` consumer altogether — so the rendered text must be
 * treated as untrusted. Without this, a malicious or careless author can
 * smuggle ANSI escapes that look like log lines, hide fake "completed" status
 * markers, or inject instructions disguised as the user's voice.
 *
 * Multi-line fields stay multi-line (newlines are preserved); only control
 * codes and zero-width separators are stripped. Length capping is left to the
 * caller — `summary`/`why`/`when` are legitimately long, while inline labels
 * like `name`/`title` benefit from `sanitizeArchInline`.
 */
export function sanitizeArchText(s: string): string {
  return (
    String(s)
      // Strip C0 controls (except \t, \n, \r) and DEL.
      // eslint-disable-next-line no-control-regex -- intentional: strip control chars
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      // Strip zero-width, bidi-override, and invisible separator code points
      // (U+200B..U+200F, U+202A..U+202E, U+2060..U+2069).
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069]/g, '')
  );
}

const ARCH_INLINE_MAX_LEN = 200;

/** Sanitize + cap for short inline labels (name/title/files list entries). */
export function sanitizeArchInline(s: string): string {
  const cleaned = sanitizeArchText(s).replace(/\s+/g, ' ').trim();
  return cleaned.length > ARCH_INLINE_MAX_LEN
    ? cleaned.slice(0, ARCH_INLINE_MAX_LEN) + '…'
    : cleaned;
}

/**
 * Render the markdown section for a single group's arch_context result.
 * Each card line includes the card id so a caller (LLM or human) can pass it
 * to `arch_delete` without going back for a separate lookup. Returns an empty
 * array when the result has nothing to show — the empty-fallback text comes
 * from `pickArchContextEmptyText`.
 */
export function renderArchContextSection(group: string, ctx: ArchContextResult): string[] {
  if (ctx.empty) return [];
  const lines: string[] = [`## Group: ${sanitizeArchInline(group)}`];
  if (ctx.components.length) {
    lines.push('### Components');
    for (const c of ctx.components) {
      const files = c.files.length > 0 ? c.files.map((f) => sanitizeArchInline(f)).join(', ') : '—';
      const stale = isStale(c.updatedAt) ? '⚠ stale ' : '';
      const name = sanitizeArchInline(c.name);
      lines.push(
        `- ${stale}**${name}** (id \`${c.id}\`, ${formatAge(c.updatedAt)}, score ${c.score.toFixed(2)}, files: ${files})`
      );
      // `summary` is structured markdown with four sections, typically
      // multi-line. Render it as an indented block beneath the header so
      // every line of the summary stays inside the bullet.
      if (c.summary) {
        for (const line of sanitizeArchText(c.summary).split('\n')) lines.push(`  ${line}`);
      }
    }
  }
  if (ctx.decisions.length) {
    lines.push('### Decisions');
    for (const d of ctx.decisions) {
      const stale = isStale(d.updatedAt) ? '⚠ stale ' : '';
      const title = sanitizeArchInline(d.title);
      // `decision` is documented as one sentence, but defensively re-indent
      // newlines in case a caller wrote a multi-line value — keeps the bullet
      // structure intact either way.
      const decision = sanitizeArchText(d.decision).replace(/\n/g, '\n  ');
      lines.push(
        `- ${stale}**${title}** (id \`${d.id}\`, ${formatAge(d.updatedAt)}, score ${d.score.toFixed(2)}) — ${decision}`
      );
    }
  }
  if (ctx.lessons.length) {
    lines.push('### Lessons');
    for (const l of ctx.lessons) {
      const stale = isStale(l.updatedAt) ? '⚠ stale ' : '';
      // `rule` is one sentence by contract, but multi-line wording slips in;
      // keep the bullet intact by re-indenting any embedded newlines.
      const rule = sanitizeArchText(l.rule).replace(/\n/g, '\n  ');
      lines.push(
        `- ${stale}(id \`${l.id}\`, ${l.severity}, ${formatAge(l.updatedAt)}, score ${l.score.toFixed(2)}) ${rule}`
      );
      // why/when give the incident context behind the rule — often more
      // load-bearing than the rule itself, since they tell the agent when
      // the rule actually applies. Render as indented continuation bullets.
      // Re-indent newlines to four spaces so wrapped lines stay aligned under
      // the two-space sub-bullet.
      if (l.why) lines.push(`  - **why:** ${sanitizeArchText(l.why).replace(/\n/g, '\n    ')}`);
      if (l.when) lines.push(`  - **when:** ${sanitizeArchText(l.when).replace(/\n/g, '\n    ')}`);
    }
  }
  lines.push('');
  return lines;
}

/** Tool names available in each mode.
 *
 * Architectural-memory split: write tools (`arch_record_*`) live in coding mode
 * only — that's where the agent is making changes and observing what's
 * non-obvious. Support mode is strictly read-only: it's used by non-coders
 * (support staff, on-call) who consume the memory but do not author it.
 */
export const CODING_TOOLS = new Set([
  'search_code',
  'get_chunk',
  'find_usages',
  'health_check',
  'delete_project',
  'list_projects',
  // arch memory — read + write, since coding mode is the one doing the work.
  'arch_context',
  'arch_list',
  'arch_record_component',
  'arch_record_decision',
  'arch_record_lesson',
  'arch_suggest_components',
  'arch_delete',
]);

export const SUPPORT_TOOLS = new Set([
  'search_code',
  'get_chunk',
  'find_usages',
  'health_check',
  'list_projects',
  'get_chunk_meta',
  'search_changes',
  'explain_feature',
  'recent_changes',
  'impact_analysis',
  // analytics tools
  'token_savings_report',
  'top_queries',
  'slowest_searches',
  'cross_project_share',
  'retry_rate',
  'failed_chunks',
  // arch memory — read only.
  'arch_context',
]);

/** Workflow-prompt names available in each mode. Content lives in prompts.json. */
export const CODING_PROMPTS = [
  'find_implementation',
  'trace_callers',
  'onboard_to_project',
  // arch workflows — read + write (init + record live here, where edits happen)
  'init_arch_memory',
  'audit_architecture',
  'record_lesson_from_correction',
];
export const SUPPORT_PROMPTS = [
  'triage_incident',
  'prepare_release_notes',
  'assess_change_impact',
  'onboard_to_project',
  // arch workflows — read only.
  'audit_architecture',
];

export class McpHandler {
  private searcher: Searcher;
  private indexer: Indexer;
  private getProjects: () => Map<string, ProjectConfig[]>;
  private getGroupNames: () => string[];
  private removeProject: ((group: string, projectName: string) => void) | null;
  private syncGroups: (() => Promise<void>) | null;
  private metadataStore: MetadataStore | null;
  private telemetry: Telemetry | null;
  private analytics: AnalyticsStore | null;
  private archStore: ArchStore | null;
  private metrics: MetricsRegistry;
  private sessionIdentity = new Map<
    string,
    { user: string; session: string | null; client: string | null; anchorProject: string | null }
  >();
  private transports: Record<string, TransportEntry> = {};
  private servers = new Map<string, McpServer>();
  private sessionModes = new Map<string, McpMode>();
  private sessionCreationLocks = new Set<string>();

  private readonly SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 4; // 4 hours idle timeout
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: McpHandlerConfig) {
    this.searcher = config.searcher;
    this.indexer = config.indexer;
    this.getProjects = config.getProjects;
    this.getGroupNames = config.getGroupNames;
    this.removeProject = config.removeProject ?? null;
    this.syncGroups = config.syncGroups ?? null;
    this.metadataStore = config.metadataStore ?? null;
    this.telemetry = config.telemetry ?? null;
    this.analytics = config.analytics ?? null;
    this.archStore = config.archStore ?? null;
    this.metrics = config.metrics ?? new NoOpMetrics();

    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
    this.cleanupInterval.unref(); // Don't hold event loop open
  }

  /** Sync groups with a timeout to avoid blocking session startup */
  private async syncGroupsWithTimeout(): Promise<void> {
    if (!this.syncGroups) return;
    try {
      await Promise.race([
        this.syncGroups(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('syncGroups timeout')), 5000)
        ),
      ]);
    } catch {
      // Non-fatal — groups will be discovered on next poll tick
    }
  }

  /** Mount all MCP routes on the Express app (coding + support modes) */
  mount(app: Express): void {
    // Coding mode (backwards-compatible paths)
    app.get('/sse', (req, res) => this.handleSSE(req, res, 'coding'));
    app.post('/messages', (req, res) => this.handleMessages(req, res, 'coding'));
    app.all('/mcp', (req, res) => this.handleStreamableHTTP(req, res, 'coding'));

    // Support mode
    app.get('/support/sse', (req, res) => this.handleSSE(req, res, 'support'));
    app.post('/support/messages', (req, res) => this.handleMessages(req, res, 'support'));
    app.all('/support/mcp', (req, res) => this.handleStreamableHTTP(req, res, 'support'));
  }

  /** Graceful shutdown: stop cleanup interval and remove all sessions */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const sessionId of Object.keys(this.transports)) {
      this.cleanupSession(sessionId);
    }
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

  /**
   * On a follow-up request that lacks identity headers, fall back to the
   * identity captured at session-init. Per-request headers always win.
   */
  private applySessionIdentity(sessionId: string | undefined): void {
    if (!sessionId) return;
    const ctx = tctx.get();
    if (!ctx) return;
    if (ctx.user !== 'anonymous') return;
    const stored = this.sessionIdentity.get(sessionId);
    if (!stored) return;
    tctx.patch({
      user: stored.user,
      session: stored.session,
      client: stored.client,
      anchorProject: ctx.anchorProject ?? stored.anchorProject,
    });
  }

  private cleanupSession(sessionId: string): void {
    delete this.transports[sessionId];
    this.servers.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.sessionIdentity.delete(sessionId);
  }

  /**
   * Wrap a tool callback so telemetry records each call (latency, ok/error).
   * Falls through cleanly when telemetry is not configured.
   */
  private instrumentTool<TArgs extends unknown[], TResult>(
    toolName: string,
    fn: (...args: TArgs) => Promise<TResult>
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs) => {
      if (!this.telemetry) return fn(...args);
      const start = performance.now();
      let ok = true;
      let error: string | null = null;
      try {
        return await fn(...args);
      } catch (err) {
        ok = false;
        error = (err as Error).message.slice(0, 256);
        throw err;
      } finally {
        try {
          this.telemetry.recordToolCall({
            ts: Date.now(),
            tool: toolName,
            durationMs: Math.round(performance.now() - start),
            ok,
            error,
          });
        } catch {
          // never break the tool call because of telemetry
        }
      }
    };
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

    const server = new McpServer({ name: 'paparats-mcp', version: PKG_VERSION }, { instructions });

    // Monkey-patch server.tool so every registered handler is wrapped in telemetry.
    if (this.telemetry) {
      const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
      const instrument = this.instrumentTool.bind(this);
      server.tool = ((...args: unknown[]) => {
        const last = args.length - 1;
        const handler = args[last];
        const name = typeof args[0] === 'string' ? args[0] : 'unknown';
        if (typeof handler === 'function') {
          args[last] = instrument(name, handler as (...rest: unknown[]) => Promise<unknown>);
        }
        return originalTool(...args);
      }) as typeof server.tool;
    }

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

    // ── Resource: arch://schema (static) ────────────────────────────────────
    server.resource('arch-schema', 'arch://schema', async () => ({
      contents: [
        {
          uri: 'arch://schema',
          mimeType: 'text/markdown',
          text: prompts.resources.archSchema.body,
        },
      ],
    }));

    // ── Resource: arch://stats/{group} ──────────────────────────────────────
    // Live stats for one group; the agent dereferences arch://stats/<group>
    // and gets total + breakdown by kind/status + age window. Also pushed
    // to Prometheus so operators can chart it.
    if (this.archStore) {
      const archStore = this.archStore;
      const metrics = this.metrics;
      server.resource(
        'arch-stats',
        new ResourceTemplate('arch://stats/{group}', { list: undefined }),
        async (uri, vars) => {
          const groupRaw = (vars as { group?: string | string[] }).group;
          const group = Array.isArray(groupRaw) ? groupRaw[0] : groupRaw;
          if (!group) {
            return {
              contents: [
                {
                  uri: uri.href,
                  mimeType: 'text/plain',
                  text: 'Bad URI. Expected arch://stats/<group>.',
                },
              ],
            };
          }
          const stats = await archStore.stats(group);
          // Push the snapshot to the gauge so it survives in Prometheus too.
          for (const kind of ['component', 'decision', 'lesson'] as const) {
            metrics.setArchCollectionSize(group, kind, 'all', stats.byKind[kind]);
          }
          for (const status of ['proposed', 'accepted', 'superseded', 'deprecated'] as const) {
            metrics.setArchCollectionSize(group, 'all', status, stats.byStatus[status]);
          }
          const oldest = stats.oldestUpdatedAt
            ? new Date(stats.oldestUpdatedAt).toISOString()
            : 'n/a';
          const newest = stats.newestUpdatedAt
            ? new Date(stats.newestUpdatedAt).toISOString()
            : 'n/a';
          const text = [
            `# Architectural memory — group ${group}`,
            '',
            `**Total cards:** ${stats.total}`,
            '',
            '## By kind',
            `- components: ${stats.byKind.component}`,
            `- decisions:  ${stats.byKind.decision}`,
            `- lessons:    ${stats.byKind.lesson}`,
            '',
            '## By status',
            `- proposed:   ${stats.byStatus.proposed}`,
            `- accepted:   ${stats.byStatus.accepted}`,
            `- superseded: ${stats.byStatus.superseded}`,
            `- deprecated: ${stats.byStatus.deprecated}`,
            '',
            '## Age window',
            `- oldest updatedAt: ${oldest}`,
            `- newest updatedAt: ${newest}`,
          ].join('\n');
          return {
            contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
          };
        }
      );
    }

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

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ status: 'ok', groups }, null, 2),
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
          const fetchStart = performance.now();
          let fetchFound = false;
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
            fetchFound = true;

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
          } finally {
            this.telemetry?.recordChunkFetch({
              ts: Date.now(),
              chunkId: chunk_id,
              radiusLines: radius_lines,
              durationMs: Math.round(performance.now() - fetchStart),
              found: fetchFound,
            });
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

    // ── Tool: delete_project ──────────────────────────────────────────────
    if (tools.has('delete_project'))
      server.tool(
        'delete_project',
        prompts.tools.delete_project.description,
        {
          group: z.string().describe('Group name (collection) the project belongs to'),
          project: z.string().describe('Project name to delete'),
        },
        async ({ group, project }) => {
          try {
            await this.indexer.deleteProjectChunks(group, project);
            // Metadata rows are keyed by chunk_id, which embeds the *stored*
            // (suffixed) project name — map through the indexer so the delete
            // pattern matches. Qdrant side is suffixed inside deleteProjectChunks.
            this.metadataStore?.deleteByProject(group, this.indexer.storedProjectName(project));
            this.searcher.invalidateGroupCache(group);
            this.removeProject?.(group, project);

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Deleted project "${project}" from group "${group}". All chunks, metadata, and cache entries removed. The project will be re-indexed on the next indexer cycle if configured.`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to delete project: ${(err as Error).message}`,
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
          include_hubs: z
            .boolean()
            .default(true)
            .describe(
              'When true (default) callers/callees whose own degree is above the group p95 are surfaced with a `[hub]` marker so the agent knows the link is noisy. Set false to drop hub neighbours entirely — useful when probing a specific path through the codebase.'
            ),
        },
        async ({ chunk_id, direction, relation_types, limit, include_hubs }) => {
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

            // Hub-threshold filtering: edges whose *other endpoint* is itself
            // a hub (degree above the group p95) are either marked or dropped.
            // The seed itself is always kept — even if the user is asking
            // about a hub, the question is "what touches this thing" and we
            // shouldn't silently return nothing.
            //
            // `hubChunkIds` is pre-computed inside MetadataStore and lives in
            // the per-group degree cache, so this is O(1) lookup per edge
            // without any per-call Set construction.
            const seedGroup = chunk_id.split('//')[0] ?? '';
            const hubChunkIds = seedGroup
              ? this.metadataStore.getGroupDegreeSnapshot(seedGroup).hubChunkIds
              : new Set<string>();
            const isHub = (id: string): boolean => hubChunkIds.has(id);
            if (!include_hubs) {
              edgesTo = edgesTo.filter((e) => !isHub(e.from_chunk_id));
              edgesFrom = edgesFrom.filter((e) => !isHub(e.to_chunk_id));
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
                  const conf = edge.confidence ?? 'INFERRED';
                  const hub = isHub(edge.from_chunk_id) ? ' [hub]' : '';
                  if (ep) {
                    const p = typeof ep['project'] === 'string' ? ep['project'] : 'unknown';
                    const f = typeof ep['file'] === 'string' ? ep['file'] : 'unknown';
                    const sl = typeof ep['startLine'] === 'number' ? ep['startLine'] : 0;
                    const sym = typeof ep['symbol_name'] === 'string' ? ep['symbol_name'] : null;
                    const symInfo = sym ? ` (${sym})` : '';
                    text += `- **[${p}] ${f}:${sl}**${symInfo}${hub} — ${edge.relation_type} \`${conf}\`\n`;
                    text += `  _chunk: ${edge.from_chunk_id}_\n`;
                  } else {
                    text += `- _chunk: ${edge.from_chunk_id}_${hub} — ${edge.relation_type} \`${conf}\`\n`;
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
                  const conf = edge.confidence ?? 'INFERRED';
                  const hub = isHub(edge.to_chunk_id) ? ' [hub]' : '';
                  if (ep) {
                    const p = typeof ep['project'] === 'string' ? ep['project'] : 'unknown';
                    const f = typeof ep['file'] === 'string' ? ep['file'] : 'unknown';
                    const sl = typeof ep['startLine'] === 'number' ? ep['startLine'] : 0;
                    const sym = typeof ep['symbol_name'] === 'string' ? ep['symbol_name'] : null;
                    const symInfo = sym ? ` (${sym})` : '';
                    text += `- **[${p}] ${f}:${sl}**${symInfo}${hub} — ${edge.relation_type} \`${conf}\`\n`;
                    text += `  _chunk: ${edge.to_chunk_id}_\n`;
                  } else {
                    text += `- _chunk: ${edge.to_chunk_id}_${hub} — ${edge.relation_type} \`${conf}\`\n`;
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

    // ── Tool: list_projects ────────────────────────────────────────────────
    if (tools.has('list_projects'))
      server.tool(
        'list_projects',
        prompts.tools.list_projects.description,
        {
          group: z.string().optional().describe('Specific group name, or omit to list all groups'),
        },
        async ({ group }) => {
          try {
            const groupNames = group ? [group] : this.getGroupNames();

            if (groupNames.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No groups indexed. Index a project first.',
                  },
                ],
              };
            }

            const sections: string[] = [];

            for (const g of groupNames) {
              const projects = await this.indexer.listProjectsInGroup(g);
              const stats = await this.indexer.getGroupStats(g);

              sections.push(`## Group: ${g} (${stats.points} total chunks)\n`);

              if (projects.length === 0) {
                sections.push('_No projects found in this group._\n');
                continue;
              }

              sections.push('| Project | Chunks | Languages |');
              sections.push('|---------|--------|-----------|');
              for (const p of projects) {
                sections.push(`| ${p.name} | ${p.chunks} | ${p.languages.join(', ')} |`);
              }
              sections.push('');
            }

            return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to list projects: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );

    // ── Analytics tools (support mode + analytics enabled) ─────────────────
    if (this.analytics) {
      const periodSchema = {
        since_ms: z.coerce
          .number()
          .optional()
          .describe('Period start (unix ms). Defaults to 7 days ago.'),
        until_ms: z.coerce.number().optional().describe('Period end (unix ms). Defaults to now.'),
        user: z.string().optional().describe('Filter by user id'),
        group: z.string().optional().describe('Filter by group name'),
      } as const;

      const renderJson = (
        label: string,
        payload: unknown
      ): { content: [{ type: 'text'; text: string }] } => ({
        content: [
          {
            type: 'text' as const,
            text: `**${label}**\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
          },
        ],
      });

      if (tools.has('token_savings_report'))
        server.tool(
          'token_savings_report',
          'Token-savings estimates: naive baseline vs. search-only vs. actually-consumed (uses chunk_fetches correlation).',
          periodSchema,
          async ({ since_ms, until_ms, user, group }) => {
            const result = tokenSavingsReport(this.analytics!, {
              since: since_ms,
              until: until_ms,
              user,
              group,
            });
            return renderJson('Token Savings Report', result);
          }
        );

      if (tools.has('top_queries'))
        server.tool(
          'top_queries',
          'Most-frequent queries by query_hash with one example, count, avg latency, avg result count.',
          { ...periodSchema, limit: z.coerce.number().min(1).max(100).default(20) },
          async ({ since_ms, until_ms, user, group, limit }) => {
            const rows = topQueries(
              this.analytics!,
              {
                since: since_ms,
                until: until_ms,
                user,
                group,
              },
              limit
            );
            return renderJson('Top Queries', rows);
          }
        );

      if (tools.has('slowest_searches'))
        server.tool(
          'slowest_searches',
          'Slowest individual searches in the period.',
          { ...periodSchema, limit: z.coerce.number().min(1).max(100).default(20) },
          async ({ since_ms, until_ms, user, group, limit }) => {
            const rows = slowestSearches(
              this.analytics!,
              {
                since: since_ms,
                until: until_ms,
                user,
                group,
              },
              limit
            );
            return renderJson('Slowest Searches', rows);
          }
        );

      if (tools.has('cross_project_share'))
        server.tool(
          'cross_project_share',
          'Per-user-per-anchor-project share of results that came from OTHER projects in the same group. Detects noisy cross-project search.',
          periodSchema,
          async ({ since_ms, until_ms, user, group }) => {
            const rows = crossProjectShare(this.analytics!, {
              since: since_ms,
              until: until_ms,
              user,
              group,
            });
            return renderJson('Cross-Project Share', rows);
          }
        );

      if (tools.has('retry_rate'))
        server.tool(
          'retry_rate',
          'Reformulation rate per user: searches followed by another search within a window with no chunk_fetches in between.',
          periodSchema,
          async ({ since_ms, until_ms, user, group }) => {
            const rows = retryRate(this.analytics!, {
              since: since_ms,
              until: until_ms,
              user,
              group,
            });
            return renderJson('Retry Rate', rows);
          }
        );

      if (tools.has('failed_chunks'))
        server.tool(
          'failed_chunks',
          'Aggregated chunking errors during indexing (AST failures, regex fallbacks, binary files).',
          periodSchema,
          async ({ since_ms, until_ms, group }) => {
            const rows = failedChunks(this.analytics!, {
              since: since_ms,
              until: until_ms,
              group,
            });
            return renderJson('Failed Chunks', rows);
          }
        );
    }

    // ── Tool: arch_context ──────────────────────────────────────────────────
    if (tools.has('arch_context') && this.archStore) {
      const archStore = this.archStore;
      const metrics = this.metrics;
      server.tool(
        'arch_context',
        prompts.tools['arch_context']?.description ??
          'Retrieve architectural memory relevant to a question or set of touched files.',
        {
          question: z.string().describe('Question, or comma-separated list of files being touched'),
          group: z
            .string()
            .optional()
            .describe('Specific group, or omit to query all known groups'),
          min_score: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              `Drop hits whose cosine similarity is below this threshold. Default ${DEFAULT_MIN_SCORE}. Lower it (e.g. 0.30) when the arch memory is sparse and you want broader recall; raise it (e.g. 0.60) when you only want high-confidence matches.`
            ),
          project: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Scope results to a single project inside the group (same value the indexer uses as `payload.project` on code chunks). Components are filtered hard — a component without `project=X` is dropped. Decisions and lessons are filtered soft — cards with `project=X` OR no `project` field pass through, so globally-scoped guidance still surfaces. Omit to query the whole group.'
            ),
          limits: z
            .object({
              component: z.number().int().min(0).max(50).optional(),
              decision: z.number().int().min(0).max(50).optional(),
              lesson: z.number().int().min(0).max(50).optional(),
            })
            .optional()
            .describe(
              'Per-kind result limits — components, decisions, and lessons each get their own top-N so a verbose decision bucket cannot starve components out of the output. Default is 5 per kind. Set a kind to 0 to suppress it entirely.'
            ),
        },
        async ({ question, group, min_score, project, limits }) => {
          const groupNames = group ? [group] : this.getGroupNames();
          if (groupNames.length === 0) {
            return {
              content: [
                { type: 'text' as const, text: 'No groups registered. Index a project first.' },
              ],
            };
          }
          // Embed the question once, then fan out across groups in parallel —
          // each call hits its own Qdrant collection, so they don't contend.
          const vector = await archStore.embedQuestion(question);
          const results = await Promise.all(
            groupNames.map(async (g) => {
              metrics.incArchContextCallsTotal(g);
              return {
                group: g,
                ctx: await buildArchContextWithVector(archStore, g, vector, {
                  ...(typeof min_score === 'number' ? { minScore: min_score } : {}),
                  ...(project !== undefined ? { project } : {}),
                  ...(limits !== undefined ? { limits } : {}),
                }),
              };
            })
          );
          const sections: string[] = [];
          let anyEmpty = false;
          let lastHint: string | null = null;
          for (const { group: g, ctx: r } of results) {
            if (r.empty) {
              anyEmpty = true;
              lastHint = r.hint;
              continue;
            }
            for (const c of r.components) metrics.observeArchSearchScore(c.score);
            for (const d of r.decisions) metrics.observeArchSearchScore(d.score);
            for (const l of r.lessons) metrics.observeArchSearchScore(l.score);
            sections.push(...renderArchContextSection(g, r));
          }
          if (sections.length === 0 && anyEmpty) {
            return {
              content: [{ type: 'text' as const, text: pickArchContextEmptyText(lastHint, mode) }],
            };
          }
          return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
        }
      );
    }

    // ── Tool: arch_record_component ─────────────────────────────────────────
    if (tools.has('arch_record_component') && this.archStore) {
      const archStore = this.archStore;
      const metrics = this.metrics;
      server.tool(
        'arch_record_component',
        prompts.tools['arch_record_component']?.description ??
          'Record or update an architectural component.',
        {
          group: z.string().describe('Target group'),
          project: z
            .string()
            .min(1)
            .describe(
              'Required. Project the component belongs to — the same value the indexer writes as `payload.project` on code chunks (typically the repo directory basename). Components in the same group with the same name but different projects coexist independently.'
            ),
          name: z
            .string()
            .describe(
              'Component name, unique per (group, project). Stable, refactor-resistant — e.g. "file indexer", not "Indexer (in indexer.ts)".'
            ),
          summary: z
            .string()
            .describe(
              'Markdown with four sections, each one or two short lines:\n' +
                '- **Does:** what it does\n' +
                '- **Owns:** state / DB tables / external IO it controls\n' +
                '- **Does not:** one or two things it explicitly does NOT do (boundary)\n' +
                '- **Touched when:** what kind of change forces editing this component'
            ),
          files: z
            .array(z.string())
            .default([])
            .describe(
              'Repository paths the component spans (e.g. packages/server/src/indexer.ts).'
            ),
          neighbours: z
            .array(z.string())
            .default([])
            .describe(
              'Names of related components (matches `name` of other arch_record_component entries).'
            ),
          anchors: z
            .array(z.string())
            .default([])
            .describe(
              'Exported class / function / constant names that survive refactors. Used later to verify the card is not pointing at deleted code.'
            ),
        },
        async ({ group, project, name, summary, files, neighbours, anchors }) => {
          const result = await archStore.upsertComponent(group, {
            project,
            name,
            summary,
            files,
            neighbours,
            anchors,
          });
          metrics.incArchWriteTotal('component', result.status);
          const verb = result.status === 'updated' ? 'Updated' : 'Recorded';
          return {
            content: [
              {
                type: 'text' as const,
                text: `${verb} component "${name}" (id=${result.id}, status=${result.status}).`,
              },
            ],
          };
        }
      );
    }

    // ── Tool: arch_record_decision ──────────────────────────────────────────
    if (tools.has('arch_record_decision') && this.archStore) {
      const archStore = this.archStore;
      const metrics = this.metrics;
      server.tool(
        'arch_record_decision',
        prompts.tools['arch_record_decision']?.description ?? 'Record an architectural decision.',
        {
          group: z.string().describe('Target group'),
          project: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Optional. Project this decision is scoped to (same value the indexer uses in `payload.project`). Omit for decisions that apply across all projects in the group.'
            ),
          title: z
            .string()
            .describe('Short imperative title — e.g. "Use bge-m3 for arch-layer text embeddings".'),
          context: z.string().describe('One sentence: the problem that forced the decision.'),
          decision: z.string().describe('One sentence: what was chosen.'),
          alternatives_rejected: z
            .string()
            .default('')
            .describe(
              'Markdown bullet list, one per rejected alternative:\n' +
                '- **<option name>:** why rejected (one sentence)\n' +
                '- **<option name>:** why rejected (one sentence)\n' +
                'Use an empty string only if no real alternatives were considered.'
            ),
          consequences: z
            .string()
            .describe(
              'Markdown bullet list, 2-5 items. Each item is one sentence: a consequence, a trade-off, or a required follow-up.'
            ),
          scope: z.enum(['global', 'component', 'file']).default('global'),
          supersedes: z
            .string()
            .nullable()
            .optional()
            .describe(
              'Id of a previous decision this one replaces. Bypasses the duplicate gate — pass only when you are deliberately replacing a known prior decision.'
            ),
        },
        async ({
          group,
          project,
          title,
          context,
          decision,
          alternatives_rejected,
          consequences,
          scope,
          supersedes,
        }) => {
          const result = await archStore.upsertDecision(group, {
            ...(project !== undefined ? { project } : {}),
            title,
            context,
            decision,
            alternativesRejected: alternatives_rejected,
            consequences,
            scope,
            supersedes: supersedes ?? null,
          });
          metrics.incArchWriteTotal('decision', result.status);
          return {
            content: [
              { type: 'text' as const, text: formatWriteResult('decision', title, result) },
            ],
          };
        }
      );
    }

    // ── Tool: arch_record_lesson ────────────────────────────────────────────
    if (tools.has('arch_record_lesson') && this.archStore) {
      const archStore = this.archStore;
      const metrics = this.metrics;
      server.tool(
        'arch_record_lesson',
        prompts.tools['arch_record_lesson']?.description ?? 'Record a lesson.',
        {
          group: z.string().describe('Target group'),
          project: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Optional. Project this lesson is scoped to (same value the indexer uses in `payload.project`). Omit for lessons that apply across all projects in the group.'
            ),
          rule: z
            .string()
            .describe(
              'One imperative sentence — the rule itself. E.g. "Always preserve createdAt on re-upsert."'
            ),
          why: z
            .string()
            .describe(
              '1-3 sentences. The incident or reason. Quote the user verbatim if they corrected you.'
            ),
          when: z
            .string()
            .describe(
              'One sentence describing the situation in which this rule applies. Future-you must be able to recognise it.'
            ),
          scope: z.enum(['global', 'component', 'file']).default('global'),
          severity: z.enum(['info', 'warning', 'critical']).default('info'),
          evidence: z
            .string()
            .nullable()
            .optional()
            .describe('Optional commit hash, PR link, or short quote backing the lesson.'),
        },
        async ({ group, project, rule, why, when, scope, severity, evidence }) => {
          const result = await archStore.upsertLesson(group, {
            ...(project !== undefined ? { project } : {}),
            rule,
            why,
            when,
            scope,
            severity,
            evidence: evidence ?? null,
          });
          metrics.incArchWriteTotal('lesson', result.status);
          return {
            content: [{ type: 'text' as const, text: formatWriteResult('lesson', rule, result) }],
          };
        }
      );
    }

    // ── Tool: arch_list ─────────────────────────────────────────────────────
    if (tools.has('arch_list') && this.archStore) {
      const archStore = this.archStore;
      server.tool(
        'arch_list',
        prompts.tools['arch_list']?.description ?? 'List all arch cards in a group.',
        {
          group: z.string().min(1).describe('Group to list cards from.'),
          project: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Optional. Restrict to one project. Components must match this project (hard filter); decisions and lessons match this project OR have no project field (soft filter, so group-wide guidance still surfaces).'
            ),
          kinds: z
            .array(z.enum(['component', 'decision', 'lesson']))
            .optional()
            .describe('Optional. Restrict to a subset of card kinds.'),
          include_history: z
            .boolean()
            .optional()
            .describe('Optional. Include superseded/deprecated cards. Default false.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe('Optional. Page size, default 50, max 200.'),
          offset: z
            .union([z.string(), z.number()])
            .optional()
            .describe(
              'Optional. Resume cursor from a previous call (`next_offset`). Pass the value verbatim — strings that look like JSON (start with `{` or `[`) are parsed back to the structured form Qdrant emits. Omit for the first page.'
            ),
        },
        async ({ group, project, kinds, include_history, limit, offset }) => {
          // Tool-surface cursors are always strings or numbers. Internally
          // Qdrant can emit a structured object id; we JSON-encode on output
          // and decode here on input so the round-trip is transparent.
          const decodedOffset: string | number | Record<string, unknown> | undefined =
            typeof offset === 'string' && (offset.startsWith('{') || offset.startsWith('['))
              ? (tryParseObjectOffset(offset) ?? offset)
              : offset;
          const { points, nextOffset } = await archStore.listPoints(group, {
            project,
            kinds,
            includeHistory: include_history,
            limit,
            ...(decodedOffset !== undefined ? { offset: decodedOffset } : {}),
          });
          if (points.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No cards found in group \`${group}\`${project ? ` for project \`${project}\`` : ''}.`,
                },
              ],
            };
          }
          const rows: string[] = [
            `Group: ${group}${project ? ` · project: ${project}` : ''}`,
            `Returned ${points.length} card(s)${nextOffset !== null ? ' — more available, pass next_offset to continue' : ''}.`,
            '',
          ];
          for (const p of points) {
            const stale = isStale(p.updatedAt) ? '⚠ stale ' : '';
            const cardProject = (p as { project?: unknown }).project;
            const projectLabel =
              typeof cardProject === 'string'
                ? `project=${sanitizeArchInline(cardProject)}`
                : 'global';
            const rawLabel =
              p.kind === 'component' ? p.name : p.kind === 'decision' ? p.title : p.rule;
            const label = sanitizeArchInline(rawLabel);
            const cardStatus = (p as { status?: unknown }).status;
            const status =
              typeof cardStatus === 'string' ? sanitizeArchInline(cardStatus) : 'accepted';
            rows.push(
              `- ${stale}[${p.kind}] **${label}** (id \`${p.id}\`, ${projectLabel}, status=${status}, ${formatAge(p.updatedAt)})`
            );
          }
          if (nextOffset !== null) {
            rows.push('');
            const encoded =
              typeof nextOffset === 'string' || typeof nextOffset === 'number'
                ? String(nextOffset)
                : JSON.stringify(nextOffset);
            rows.push(`next_offset: \`${encoded}\``);
          }
          return { content: [{ type: 'text' as const, text: rows.join('\n') }] };
        }
      );
    }

    // ── Tool: arch_suggest_components ───────────────────────────────────────
    if (tools.has('arch_suggest_components') && this.archStore) {
      const archStore = this.archStore;
      server.tool(
        'arch_suggest_components',
        prompts.tools['arch_suggest_components']?.description ??
          'Suggest candidate components to record based on symbol-graph centrality.',
        {
          group: z.string().min(1).describe('Group to analyse.'),
          project: z
            .string()
            .min(1)
            .optional()
            .describe('Optional. Restrict suggestions to one project in the group.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('Optional. Max suggestions to return. Default 10.'),
        },
        async ({ group, project, limit }) => {
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
          const max = limit ?? 10;
          // Overfetch: many top-degree chunks will already be covered by an
          // existing component card, so we need a buffer before we hit `max`
          // suggestions. 5x is plenty for normal projects.
          const candidates = this.metadataStore.getTopByInDegree(group, max * 5, project);
          if (candidates.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No symbol-graph edges found for group \`${group}\`${project ? ` / project \`${project}\`` : ''}. Index the project first or run \`find_usages\` to verify edges exist.`,
                },
              ],
            };
          }

          // Pull every existing component once, so we can filter out chunks
          // whose file is already covered by a card. listPoints paginates;
          // we follow the cursor to exhaustion. Components are typically a
          // few dozen per group, so this is cheap.
          const coveredFiles = new Set<string>();
          let offset: string | number | Record<string, unknown> | undefined = undefined;
          for (;;) {
            const page = await archStore.listPoints(group, {
              kinds: ['component'],
              limit: 200,
              ...(project !== undefined ? { project } : {}),
              ...(offset !== undefined ? { offset } : {}),
            });
            for (const p of page.points) {
              if (p.kind !== 'component') continue;
              for (const f of p.files) coveredFiles.add(f);
            }
            if (page.nextOffset === null) break;
            offset = page.nextOffset;
          }

          // Pair each candidate chunk with its payload (for file + symbol).
          const payloads = await Promise.all(
            candidates.map((c) => this.indexer.getChunkById(c.chunkId))
          );
          const suggestions: Array<{
            file: string;
            project: string;
            symbol: string;
            degree: number;
            chunkId: string;
          }> = [];
          const seenFiles = new Set<string>();
          for (let i = 0; i < candidates.length; i++) {
            if (suggestions.length >= max) break;
            const c = candidates[i]!;
            const p = payloads[i];
            if (!p) continue;
            const f = typeof p['file'] === 'string' ? p['file'] : null;
            if (!f) continue;
            if (coveredFiles.has(f)) continue;
            if (seenFiles.has(f)) continue;
            seenFiles.add(f);
            const proj = typeof p['project'] === 'string' ? p['project'] : 'unknown';
            const sym =
              typeof p['symbol_name'] === 'string' && p['symbol_name'].length > 0
                ? p['symbol_name']
                : '(unnamed)';
            suggestions.push({
              file: f,
              project: proj,
              symbol: sym,
              degree: c.degree,
              chunkId: c.chunkId,
            });
          }

          if (suggestions.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `All high-degree symbols in group \`${group}\`${project ? ` / project \`${project}\`` : ''} are already covered by component cards. Nothing to suggest.`,
                },
              ],
            };
          }

          const rows: string[] = [
            `## Suggested components — group \`${group}\`${project ? `, project \`${project}\`` : ''}`,
            '',
            'Ranked by symbol-graph in-degree. These files contain the most-called symbols not yet covered by a component card. Read each, judge whether it represents a meaningful boundary, and write it via `arch_record_component` when appropriate.',
            '',
          ];
          for (const s of suggestions) {
            rows.push(
              `- **[${s.project}] ${s.file}** — symbol \`${s.symbol}\`, in-degree ${s.degree}`
            );
            rows.push(`  _chunk: ${s.chunkId}_`);
          }
          return { content: [{ type: 'text' as const, text: rows.join('\n') }] };
        }
      );
    }

    // ── Tool: arch_delete ───────────────────────────────────────────────────
    if (tools.has('arch_delete') && this.archStore) {
      const archStore = this.archStore;
      server.tool(
        'arch_delete',
        prompts.tools['arch_delete']?.description ?? 'Hard-delete arch cards by id.',
        {
          group: z.string().min(1).describe('Group the cards live in.'),
          ids: z
            .array(z.string().min(1))
            .min(1)
            .describe(
              'Card ids to delete. Idempotent: ids that no longer exist are reported in `notFound` but do not fail the call.'
            ),
        },
        async ({ group, ids }) => {
          const { deleted, notFound } = await archStore.deletePoints(group, ids);
          const lines: string[] = [`Deleted ${deleted.length} card(s) from group \`${group}\`.`];
          if (notFound.length > 0) {
            lines.push(`Not found (already removed?): ${notFound.join(', ')}.`);
          }
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
      );
    }

    // ── Workflow prompts ─────────────────────────────────────────────────────
    const promptNames = mode === 'coding' ? CODING_PROMPTS : SUPPORT_PROMPTS;
    for (const name of promptNames) {
      const workflow = prompts.workflows[name];
      if (!workflow) continue;
      server.registerPrompt(
        name,
        {
          title: workflow.title,
          description: workflow.description,
          argsSchema: buildWorkflowArgsSchema(workflow.args),
        },
        (rawArgs) => {
          const args = rawArgs as Record<string, string | undefined>;
          return {
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: interpolateWorkflowMessage(workflow.message, args),
                },
              },
            ],
          };
        }
      );
    }

    return server;
  }

  // ── SSE transport (Cursor) ──────────────────────────────────────────────

  private async handleSSE(_req: Request, res: Response, mode: McpMode): Promise<void> {
    try {
      // Refresh group list before serving a new session
      await this.syncGroupsWithTimeout();

      const messagesPath = mode === 'coding' ? '/messages' : '/support/messages';
      const transport = new SSEServerTransport(messagesPath, res);
      const sessionId = transport.sessionId;

      const now = Date.now();
      this.transports[sessionId] = { transport, created: now, lastActivity: now };
      this.sessionModes.set(sessionId, mode);
      const ctx = tctx.get();
      if (ctx && ctx.user !== 'anonymous') {
        this.sessionIdentity.set(sessionId, {
          user: ctx.user,
          session: ctx.session ?? sessionId,
          client: ctx.client,
          anchorProject: ctx.anchorProject,
        });
      }
      res.on('close', () => this.cleanupSession(sessionId));

      const server = this.getMcpServer(sessionId, mode);
      await server.connect(transport);
    } catch (err) {
      console.error('[mcp] SSE error:', err);
      if (!res.headersSent) res.status(500).send('Internal error');
    }
  }

  private sendModeMismatchError(res: Response, sessionMode: McpMode, targetMode: McpMode): void {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Session belongs to ${sessionMode} mode, but was sent to ${targetMode} endpoint`,
      },
      id: null,
    });
  }

  private async handleMessages(req: Request, res: Response, mode: McpMode): Promise<void> {
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

      const sessionMode = sessionId ? this.sessionModes.get(sessionId) : undefined;
      if (sessionMode && sessionMode !== mode) {
        this.sendModeMismatchError(res, sessionMode, mode);
        return;
      }

      entry.lastActivity = Date.now();
      this.applySessionIdentity(sessionId);
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
        const sessionMode = sessionId ? this.sessionModes.get(sessionId) : undefined;
        if (sessionMode && sessionMode !== mode) {
          this.sendModeMismatchError(res, sessionMode, mode);
          return;
        }
        transportEntry.lastActivity = Date.now();
        this.applySessionIdentity(sessionId);
        const t = transportEntry.transport;
        if ('handleRequest' in t) {
          await t.handleRequest(req, res, req.body);
        }
        return;
      }

      if (!sessionId && req.method === 'POST' && this.isInitializeRequest(req.body)) {
        // Refresh group list before serving a new session
        await this.syncGroupsWithTimeout();

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
              const ctx = tctx.get();
              if (ctx && ctx.user !== 'anonymous') {
                this.sessionIdentity.set(sid, {
                  user: ctx.user,
                  session: ctx.session ?? sid,
                  client: ctx.client,
                  anchorProject: ctx.anchorProject,
                });
              }
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
        const knownMode = this.sessionModes.get(sessionId);
        if (knownMode && knownMode !== mode) {
          this.sendModeMismatchError(res, knownMode, mode);
          return;
        }
        // Session ID was provided but not found — expired or server restarted.
        // Instead of returning 404, transparently recreate the session with the same ID.
        // This allows clients to survive server restarts without re-initializing.
        console.log(`[mcp] Recreating lost session ${sessionId}`);

        // Refresh group list for the recreated session
        await this.syncGroupsWithTimeout();

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
