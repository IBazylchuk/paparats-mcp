export interface RepoConfig {
  /** Repository URL (e.g. https://github.com/org/repo.git) */
  url: string;
  /** Owner/org (e.g. "org") */
  owner: string;
  /** Repository name (e.g. "repo") */
  name: string;
  /** Full identifier (e.g. "org/repo") */
  fullName: string;
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
