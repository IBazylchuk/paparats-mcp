---
'@paparats/shared': minor
'@paparats/cli': minor
'@paparats/server': minor
'@paparats/indexer': minor
---

Add OpenAI and Voyage AI embedding providers, plus a collection-level
mismatch guard so swapping providers never silently breaks search.

- **`OpenAIProvider`** (`text-embedding-3-small`, 1536d) and **`VoyageProvider`**
  (`voyage-code-3`, 1024d, Matryoshka-aware) join the existing `OllamaProvider`.
  Both share a single retry helper that treats 4xx (bad key, no credit,
  malformed input) as terminal and retries 429/5xx with exponential backoff.
- **`resolveEmbeddingConfigFromEnv()`** centralises the env contract for
  server and indexer. Precedence: explicit `EMBEDDING_PROVIDER` →
  `OPENAI_API_KEY` present → `VOYAGE_API_KEY` present → Ollama. Setting just
  an API key auto-switches providers.
- **Collection metadata sentinel.** Each Qdrant collection now carries a
  hidden `__meta` point recording the provider, model, and dimensions that
  stamped it. Reopening a collection with a different provider raises
  `CollectionMetaMismatchError` with a clear remediation. Legacy collections
  without the sentinel get backfilled with a warning, so existing setups
  continue to work.
- **Searcher** transparently excludes the sentinel via `must_not __meta=true`
  on every Qdrant search.
- **Codespaces** now forwards `OPENAI_API_KEY` / `VOYAGE_API_KEY` /
  `EMBEDDING_PROVIDER` from the host shell — set one of those secrets and
  indexing drops from ~15 minutes to a couple of seconds.
- README documents the three providers with a trade-off table (cost,
  privacy, speed) and the selection precedence.

Out of scope here: a `paparats install --embeddings <provider>` flag and the
Docker Compose generator's "skip Ollama service when cloud provider is set"
flow. Both will follow in a smaller CLI-focused PR.
