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

#### AST-Based Symbol Extraction

- New `ast-symbol-extractor.ts` module with tree-sitter WASM-based symbol extraction
- Supports 10 languages: TypeScript/JavaScript/TSX, Python, Go, Rust, Java, Ruby, C, C++, C#
- Extracts `defined_symbols` (name + kind) and `uses_symbols` per chunk from AST
- `kind` classification derived from tree-sitter parent node types (function, class, method, interface, type, enum, constant, variable, module)
- New `ast-queries.ts` — tree-sitter S-expression query patterns per language
- Indexer populates `symbol_name` and `kind` from tree-sitter results (replaces old regex-based extraction)

#### Symbol Graph

- New `symbol-graph.ts` — builds cross-chunk symbol edges (`calls`, `called_by`, `references`, `referenced_by`)
- Edges stored in SQLite metadata store for fast lookup
- Post-indexing hook builds symbol graph automatically when tree-sitter is available

#### New MCP Tool: `find_usages`

- Find all chunks that use a given symbol name
- Powered by Qdrant `defines_symbols` / `uses_symbols` keyword indices

#### New MCP Tool: `list_related_chunks`

- List chunks related to a given chunk via symbol graph edges
- Shows call/reference relationships between chunks

#### Metadata Configuration

- New `metadata` section in `.paparats.yml` supporting `service`, `bounded_context`, `tags`, and `directory_tags`
- New `metadata.ts` module with `resolveTags()` and `autoDetectTags()` helpers
- Auto-detection fallback: `service` defaults to project name, `tags` inferred from directory structure

#### New MCP Tools: `get_chunk` and `get_chunk_meta`

- `get_chunk(chunk_id, radius_lines?)` — retrieve a chunk with optional context expansion
- `get_chunk_meta(chunk_id, commit_limit?)` — git metadata including commits and ticket references

#### New MCP Tool: `search_changes`

- Search for recently changed code with date filter on last commit time

#### Git History Extraction

- New `git-metadata.ts` — extracts commit history per file, maps commits to chunks by diff hunk overlap
- New `metadata-db.ts` — SQLite store for git commits, tickets, and symbol edges
- New `ticket-extractor.ts` — extracts Jira, GitHub, and custom ticket references from commit messages
- Git metadata extraction is non-fatal — errors are logged but don't block indexing

#### Extended Qdrant Payload

- Payload fields per chunk: `chunk_id`, `symbol_name`, `kind`, `service`, `bounded_context`, `tags`, `defines_symbols`, `uses_symbols`, `last_commit_hash`, `last_commit_at`, `last_author_email`, `ticket_keys`
- Keyword indices on `chunk_id`, `kind`, `tags`, `last_commit_at`, `ticket_keys`, `defines_symbols`, `uses_symbols`

#### Searcher: Filtered Search

- New `searchWithFilter()` method — accepts additional Qdrant filter conditions

#### AST-Based Code Chunking

- New `ast-chunker.ts` — tree-sitter AST-based chunking replaces regex heuristics as primary strategy
- `chunkByAst()` uses top-level AST nodes as natural chunk boundaries, groups small nodes, splits large nodes recursively by children
- Fixes broken chunking for Go (`func`), Rust (`fn`), Java (`public class`), C/C++/C# which previously fell through to fixed-size splitting
- Added TSX support in regex chunker fallback (`chunkByBraces`)

### Changed

- Indexer uses single-parse flow: `chunkFile()` parses once with tree-sitter, uses tree for both AST chunking and symbol extraction, then deletes tree
- Symbol extraction moved from regex (chunker) to tree-sitter AST (indexer) — single source of truth
- Removed `symbol-extractor.ts` (regex-based) — replaced by `ast-symbol-extractor.ts`
- Renamed `ts-queries.ts` → `ast-queries.ts`, `ts-symbol-extractor.ts` → `ast-symbol-extractor.ts`
- Removed dead `ChunkResult` fields (`symbol_name`, `kind`, `defines_symbols`, `uses_symbols`) — indexer populates these directly in Qdrant payload
- Removed dead `ChunkKind` values (`route`, `resource`, `block`) — never produced by AST system
- Standardized chunk line numbers to 0-indexed throughout (chunker, AST chunker, symbol extractor)
- Chunker no longer enriches chunks with symbol metadata (delegated to indexer)

### Fixed

- `/api/chunk/:chunkId` error responses no longer leak internal error messages
- `getAdjacentChunks` now paginates Qdrant scroll results instead of hardcoding `limit: 100`
- Markdown injection prevention: language fields in code fences are sanitized via `sanitizeLang()`
- `get_chunk_meta` payload access uses safe `typeof` checks instead of unsafe `as` casts
- `getChunkById` and `getAdjacentChunks` catch blocks now log errors instead of silently swallowing
- `parseChunkId` import in `app.ts` changed from dynamic to static

### Notes

- All new payload fields and modules are backward compatible — old indexed data is unaffected
- A `reindex` call regenerates all metadata including git history and symbol graph (reindex is the migration path)
- Languages without tree-sitter grammar (e.g. Terraform) gracefully fall back to `null` for `symbol_name`/`kind`

## [0.1.10] - 2025-05-22

### Fixed

- Memory leaks in watcher, MCP handler, and HTTP timeout utilities

## [0.1.9] - 2025-05-21

### Changed

- Refactored release process and added `release:push` script

## [0.1.8] - 2025-05-20

### Changed

- Updated publish-mcp workflow to trigger on version tag pushes
