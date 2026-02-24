# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Stable Chunk IDs

- Deterministic `chunk_id` payload field with format `{group}//{project}//{file}//{startLine}-{endLine}//{hash}`
- `buildChunkId()` and `parseChunkId()` helpers in `indexer.ts`
- Qdrant keyword payload index on `chunk_id` for fast lookup

#### Symbol Extraction

- New `symbol-extractor.ts` module with regex-based symbol extraction from code chunks
- Supports 11 languages: TypeScript/JavaScript, Python, Go, Rust, Java, Ruby, C/C++, C#, Terraform
- Extracts symbol name and kind (function, class, method, interface, type, enum, constant, variable, module, route, resource, block) from the first 5 lines of each chunk
- Chunker automatically enriches chunks with `symbol_name` and `kind` during processing

#### Metadata Configuration

- New `metadata` section in `.paparats.yml` supporting `service`, `bounded_context`, `tags`, and `directory_tags`
- New `metadata.ts` module with `resolveTags()` and `autoDetectTags()` helpers
- Auto-detection fallback: `service` defaults to project name, `tags` inferred from directory structure (e.g., `src/controllers/foo.ts` produces `controllers` tag)

#### New MCP Tool: `get_chunk`

- Retrieve a specific chunk by `chunk_id` via `get_chunk(chunk_id, radius_lines?)`
- `radius_lines` parameter (0-200) expands context by fetching adjacent chunks in the same file
- Returns formatted metadata header + code block

#### New HTTP Endpoint

- `GET /api/chunk/:chunkId` with optional `radius_lines` query parameter
- Returns chunk payload as JSON, includes `adjacent_chunks` when radius is specified

#### Enriched Search Results

- `search_code` results now include `chunk_id`, `symbol_name`, `kind`, `service`, `bounded_context`, and `tags`
- Formatted output shows symbol info and chunk reference for each result

#### Extended Qdrant Payload

- New payload fields per chunk: `chunk_id`, `symbol_name`, `kind`, `service`, `bounded_context`, `tags`
- Qdrant keyword indices on `chunk_id`, `kind`, and `tags` for filtered queries
- All new fields are optional for backward compatibility with pre-existing data

#### New Types

- `ChunkKind` type union for symbol classification
- `MetadataConfig` and `ResolvedMetadataConfig` interfaces
- Extended `ChunkResult`, `SearchResult`, `PaparatsConfig`, and `ProjectConfig` types

#### Tests

- `symbol-extractor.test.ts` — 45 tests across all 11 languages and edge cases
- `metadata.test.ts` — 12 tests for tag resolution and auto-detection
- `chunk-id.test.ts` — 8 tests for chunk ID building, parsing, and roundtrip
- `chunker.test.ts` — 6 new tests for symbol enrichment in chunk results
- `config.test.ts` — 5 new tests for metadata config parsing
- Updated existing tests in `searcher.test.ts`, `indexer.test.ts`, `server.test.ts`, `mcp-handler.test.ts`, `watcher.test.ts` for new type requirements
- Total: 266 server tests (up from 190)

#### Git History Extraction

- New `git-metadata.ts` module — extracts commit history per file via `git log`, maps commits to chunks by diff hunk line-range overlap
- New `metadata-db.ts` module — SQLite store at `~/.paparats/metadata.db` with `chunk_commits` and `chunk_tickets` tables
- New `ticket-extractor.ts` module — extracts ticket references from commit messages (Jira `PROJ-123`, GitHub `#42` and `org/repo#42`, custom regex patterns)
- Post-indexing hook in `indexer.ts`: after chunking, automatically extracts git metadata and enriches Qdrant payloads
- Git metadata extraction is non-fatal — errors are logged but don't block indexing

#### Git Metadata Configuration

- New `metadata.git` section in `.paparats.yml` with `enabled` (default: `true`), `maxCommitsPerFile` (default: `50`, range 1–500), and `ticketPatterns` (custom regex strings)
- Config validation for `maxCommitsPerFile` bounds and `ticketPatterns` regex validity
- New types: `GitMetadataConfig`, `ChunkCommit`, `ChunkTicket`

#### New MCP Tool: `get_chunk_meta`

- Retrieve chunk metadata including recent git commits and ticket references via `get_chunk_meta(chunk_id, commit_limit?)`
- Returns formatted metadata header + code block + recent commits table with ticket links

#### New MCP Tool: `search_changes`

- Search for recently changed code via `search_changes(query, since?, group?, project?, limit?)`
- Uses Qdrant `last_commit_at` range filter to narrow results to a time window
- Searches across all groups when `group` is omitted

#### New HTTP Endpoint: Chunk Metadata

- `GET /api/chunk/:chunkId/meta` with optional `commit_limit` query parameter (default: 10, max: 50)
- Returns chunk payload enriched with `commits`, `tickets`, and `latest_commit` from the metadata store

#### Extended Qdrant Payload (Phase 2)

- New optional payload fields per chunk: `last_commit_hash`, `last_commit_at`, `last_author_email`, `ticket_keys`
- Qdrant keyword indices on `last_commit_at` and `ticket_keys` for filtered queries

#### Searcher: Filtered Search

- New `searchWithFilter()` method on `Searcher` — accepts additional Qdrant filter conditions merged with the standard project filter

#### Tests (Phase 2)

- `metadata-db.test.ts` — 11 tests for SQLite metadata store operations
- `git-metadata.test.ts` — 5 integration tests with real git repos
- `ticket-extractor.test.ts` — 12 tests for ticket extraction patterns
- `config.test.ts` — 8 new tests for git metadata config validation
- `searcher.test.ts` — 4 new tests for `searchWithFilter`
- Updated existing tests in `server.test.ts`, `mcp-handler.test.ts` for new endpoints and tools
- Total: 310 server tests (up from 266)

### Fixed

- `/api/chunk/:chunkId` error responses no longer leak internal error messages
- `getAdjacentChunks` now paginates Qdrant scroll results instead of hardcoding `limit: 100`
- Markdown injection prevention: language fields in code fences are sanitized via `sanitizeLang()`
- `get_chunk_meta` payload access uses safe `typeof` checks instead of unsafe `as` casts
- `getChunkById` and `getAdjacentChunks` catch blocks now log errors instead of silently swallowing
- `parseChunkId` import in `app.ts` changed from dynamic to static

### Notes

- All new payload fields and modules are backward compatible — old indexed data is unaffected
- A `reindex` call regenerates all metadata including git history (reindex is the migration path)
- No version bump yet — this covers Phase 1 + Phase 2 of the Support Q&A Roadmap

## [0.1.10] - 2025-05-22

### Fixed

- Memory leaks in watcher, MCP handler, and HTTP timeout utilities

## [0.1.9] - 2025-05-21

### Changed

- Refactored release process and added `release:push` script

## [0.1.8] - 2025-05-20

### Changed

- Updated publish-mcp workflow to trigger on version tag pushes
