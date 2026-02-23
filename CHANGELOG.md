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

### Notes

- New payload fields are backward compatible — old indexed data returns `null`/`[]` for new fields
- A `reindex` call regenerates all metadata (reindex is the migration path)
- No version bump yet — this is Phase 1 of the Support Q&A Roadmap

## [0.1.10] - 2025-05-22

### Fixed

- Memory leaks in watcher, MCP handler, and HTTP timeout utilities

## [0.1.9] - 2025-05-21

### Changed

- Refactored release process and added `release:push` script

## [0.1.8] - 2025-05-20

### Changed

- Updated publish-mcp workflow to trigger on version tag pushes
