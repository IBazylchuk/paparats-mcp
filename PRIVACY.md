# Privacy

Paparats is self-hosted software. It has no hosted service, no accounts and no
telemetry sent to its authors. Everything below happens on infrastructure you
run.

## What stays on your machine

- **Your code.** The indexer reads the repositories you add, splits them into
  chunks and stores the chunks, their embeddings and a symbol graph in your own
  Qdrant and SQLite databases.
- **Search queries.** Queries from your AI client go to your Paparats server.
  Local analytics (on by default, `PAPARATS_ANALYTICS_ENABLED=false` turns them
  off) record queries, timings and result files in a SQLite file in the
  server's data directory, so you can see what was searched. They are never uploaded.

## When data leaves your machine

Only in these cases, each of which you set up yourself:

- **Model download.** `paparats install` and the embedding image download the
  embedding models from Hugging Face. No code or queries are sent.
- **Cloud embeddings (opt-in).** If you choose OpenAI or Voyage as the embedding
  provider, code chunks and search queries are sent to that provider to be
  embedded, under that provider's terms. The default local provider sends
  nothing.
- **Remote repositories.** Repositories you add by URL are cloned and pulled
  from their Git host.
- **Remote Qdrant or shared server.** If you point Paparats at a Qdrant instance
  or a Paparats server you host elsewhere, your index and queries live there.
- **OpenTelemetry (opt-in).** With `PAPARATS_OTEL_ENABLED=true`, spans about
  searches and indexing go to the collector you configure.

## Contact

Questions or concerns: open an issue at
https://github.com/IBazylchuk/paparats-mcp/issues.
