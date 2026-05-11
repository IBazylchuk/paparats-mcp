// Event shapes consumed by Telemetry sinks.

export interface SearchResultRecord {
  rank: number;
  project: string;
  file: string | null;
  language: string | null;
  score: number;
  startLine: number;
  endLine: number;
  chunkLines: number;
  fileTotalLines: number | null;
  chunkId: string | null;
}

export interface SearchRecordEvent {
  ts: number;
  tool: string;
  groupName: string | null;
  anchorProject: string | null;
  queryText: string;
  queryHash: string;
  queryTokens: string[];
  limit: number;
  durationMs: number;
  resultCount: number;
  cacheHit: boolean;
  error: string | null;
  results: SearchResultRecord[];
}

export interface ChunkFetchEvent {
  ts: number;
  chunkId: string;
  radiusLines: number;
  durationMs: number;
  found: boolean;
}

export interface ToolCallEvent {
  ts: number;
  tool: string;
  durationMs: number;
  ok: boolean;
  error: string | null;
}

export interface IndexingRunEvent {
  id: string;
  startedAt: number;
  endedAt: number | null;
  groupName: string;
  projectName: string | null;
  trigger: 'cron' | 'api' | 'watcher' | 'cli';
  filesTotal: number;
  filesSkipped: number;
  chunksTotal: number;
  errorsTotal: number;
  status: 'running' | 'success' | 'error';
}

export interface ChunkingErrorEvent {
  ts: number;
  runId: string | null;
  groupName: string;
  projectName: string;
  file: string;
  language: string | null;
  errorClass:
    | 'ast_parse_failed'
    | 'ast_chunk_zero'
    | 'regex_fallback'
    | 'read_error'
    | 'binary'
    | 'other';
  message: string | null;
}

export interface EmbeddingCallEvent {
  ts: number;
  kind: 'query' | 'passage' | 'batch';
  batchSize: number;
  cacheHits: number;
  cacheMiss: number;
  durationMs: number;
  timeout: boolean;
  error: string | null;
}

export interface FileSnapshotRecord {
  groupName: string;
  projectName: string;
  file: string;
  language: string | null;
  totalLines: number;
  totalBytes: number;
  indexedAt: number;
}
