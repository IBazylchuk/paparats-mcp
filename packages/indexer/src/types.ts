export interface RepoConfig {
  /** Repository URL (e.g. https://github.com/org/repo.git) */
  url: string;
  /** Owner/org (e.g. "org") */
  owner: string;
  /** Repository name (e.g. "repo") */
  name: string;
  /** Full identifier (e.g. "org/repo") */
  fullName: string;
  /** Per-repo overrides from indexer config file */
  overrides?: RepoOverrides;
}

/** Per-repo overrides in paparats-indexer.yml */
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

/** Structure of paparats-indexer.yml */
export interface IndexerFileConfig {
  repos: Array<
    {
      /** Repository in "owner/repo" format */
      url: string;
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
