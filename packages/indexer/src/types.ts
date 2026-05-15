export interface RepoConfig {
  /** Repository URL (e.g. https://github.com/org/repo.git). Empty string for local-path projects. */
  url: string;
  /** Owner/org (e.g. "org"). "_local" for local-path projects. */
  owner: string;
  /** Repository name (e.g. "repo") */
  name: string;
  /** Full identifier (e.g. "org/repo" or just the name for local). */
  fullName: string;
  /** Absolute path to the project on the indexer's filesystem (bind-mounted from host). */
  localPath?: string;
  /** Per-repo overrides from indexer config file */
  overrides?: RepoOverrides;
}

/** Per-repo overrides in projects.yml */
export interface RepoOverrides {
  group?: string;
  language?: string | string[];
  indexing?: {
    paths?: string[];
    exclude?: string[];
    exclude_extra?: string[];
    respectGitignore?: boolean;
    extensions?: string[];
    chunkSize?: number;
    overlap?: number;
    concurrency?: number;
    batchSize?: number;
  };
  metadata?: {
    service?: string;
    bounded_context?: string;
    tags?: string[];
    directory_tags?: Record<string, string[]>;
    git?: {
      enabled?: boolean;
      maxCommitsPerFile?: number;
      ticketPatterns?: string[];
    };
  };
}

/**
 * Structure of projects.yml.
 * Each repo entry must have exactly one source: `url` (remote git) or `path` (local bind-mount).
 */
export interface IndexerFileConfig {
  repos: Array<
    {
      /** Repository in "owner/repo" format. Mutually exclusive with `path`. */
      url?: string;
      /** Absolute host path mounted at /projects/<name> in the indexer container. Mutually exclusive with `url`. */
      path?: string;
      /** Optional override for the project name (defaults to basename of `path` or repo of `url`). */
      name?: string;
    } & RepoOverrides
  >;
  defaults?: {
    group?: string;
    language?: string | string[];
    cron?: string;
    indexing?: RepoOverrides['indexing'];
    metadata?: RepoOverrides['metadata'];
  };
}

export interface IndexerConfig {
  /** Comma-separated list of repos (e.g. "org/a,org/b") */
  repos: string;
  /** GitHub token for private repos */
  githubToken?: string;
  /** Cron expression for scheduled indexing (default: every 6 hours) */
  cron: string;
  /** Qdrant URL */
  qdrantUrl: string;
  /** Ollama URL */
  ollamaUrl: string;
  /** Directory for cloned repos (default: "/data/repos") */
  reposDir: string;
  /** HTTP port for trigger/health endpoints (default: 9877) */
  port: number;
}

export type RunStatus = 'idle' | 'running' | 'success' | 'error';

export interface RepoStatus {
  repo: string;
  status: RunStatus;
  lastRun?: string;
  lastError?: string;
  chunksIndexed?: number;
}

export interface HealthResponse {
  status: RunStatus;
  lastRunAt?: string;
  nextScheduledAt?: string;
  repoCount: number;
  repos: RepoStatus[];
}
