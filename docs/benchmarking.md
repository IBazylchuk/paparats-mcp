# Retrieval benchmark

`packages/bench` measures how well search finds the code a query is about. It runs a
hand-labelled query set through the same ranking the `search_code` MCP tool uses and
scores the results offline — no LLM, no agent. Use it to back a retrieval change (hybrid
BM25, a reranker, a different embedding model, chunking) with numbers, and to show the
before/after in the PR.

The embedding-model numbers in [embeddings.md](embeddings.md#how-the-models-were-chosen) come from
public BEIR datasets (CoIR CosQA, SciFact, FiQA) and compare models in isolation. This
bench measures the whole search path — chunking, instruction prefixes,
project filtering, dedupe — on a real repository.

## What it measures

Each query has one or more expected locations: a file and, usually, a line span. The top
10 results are scored at two levels:

| Level   | A result counts when…                                         |
| ------- | ------------------------------------------------------------- |
| `file`  | its file is one of the expected files                         |
| `chunk` | it is in an expected file **and** its lines overlap the span |

For each level the report gives **Recall@1/5/10** (share of expected locations found in
the first k results), **MRR@10** (1 / rank of the first relevant result) and **nDCG@10**
(binary relevance; a second hit on an already-found location earns nothing). Ranks are
result positions — what an agent reads in order — not distinct files. Metrics are
macro-averaged over queries, overall and per query type, alongside latency p50/p95 per
query (embedding the query plus Qdrant; each run starts with an empty embedding cache, so
only exact repeats within a run skip the embed call).

Query types in the shipped dataset:

| Type            | Example                                                     |
| --------------- | ----------------------------------------------------------- |
| `nl`            | "debounce file system change events per file"               |
| `identifier`    | `validateGroupName`                                         |
| `error`         | "Qdrant failed after 3 retries"                             |
| `config`        | `CRON_FAST`, `indexing.respectGitignore`                  |
| `where`         | "where is the search request timeout configured"            |
| `code`          | a code snippet whose near-duplicates should be found        |
| `cross-package` | "how does the CLI search command reach the server's search API" |

The per-type breakdown is the point: dense-only search was expected to be weakest on exact
identifiers and error strings, where a hybrid ranker would show its gain. On this
repository's set it is not (`baselines/`: error MRR 1.000, identifier 0.950), so a ranker
change has to show its gain on the other query types.

## Running it

You need Qdrant and an embedding server — the same ones the server uses. With a local
install both are usually already up (`paparats status`); otherwise:

```bash
docker run -d --rm --name bench-qdrant -p 127.0.0.1:16333:6333 qdrant/qdrant
docker run -d --rm --name bench-embed -p 127.0.0.1:18555:8080 ibaz/paparats-embed
```

Then, from the repository root:

```bash
# First run: export the dataset commit, index it into group bench-paparats, run the queries.
yarn bench run --index --qdrant-url http://127.0.0.1:16333 --embed-url http://127.0.0.1:18555

# Later runs reuse the index (and the embedding cache, if you re-index).
yarn bench run --label my-change
```

Defaults follow the server's environment: `QDRANT_URL` (`http://localhost:6333`),
`QDRANT_API_KEY`, `EMBED_URL` (`http://127.0.0.1:18434`), `EMBEDDING_MODEL`
(`bge-code-v1`) and `EMBEDDING_DIMENSIONS` (`1536`). `yarn bench help` lists every option.

What `--index` does:

- It indexes a `git archive` export of the dataset's pinned commit (cached under
  `packages/bench/.cache/`), not your working tree, so the corpus is exactly what the
  labels were taken from. The code doing the indexing and searching is your current build,
  so a branch changes the system under test while the corpus and labels stay fixed.
  `--source <dir>` indexes a directory instead and warns if it is not at the pinned commit.
- It only ever writes to groups named `bench-*` (default `bench-<dataset name>`, i.e.
  collection `paparats_bench-paparats`), so it cannot touch a real index. `--reset` drops
  that collection first. Project names are stored with the group appended
  (`paparats-mcp@bench-paparats`), because indexing a project removes it from every other
  group: without the suffix, indexing one bench group would empty another, or a real index
  of the same project on the same Qdrant.
- Indexing embeddings are cached in `packages/bench/.cache/embeddings.db`; re-indexing an
  unchanged corpus is fast.

Each run writes `packages/bench/reports/<dataset>-<timestamp>.json` and a markdown summary
next to it (both git-ignored), and prints the summary. `--mode search` scores the plain
`/api/search` path (the limit as given, no dedupe) instead of `search_code`.

## Comparing runs

```bash
# On main
yarn bench run --index --reset --label base --out /tmp/base.json
# On your branch, after rebuilding
yarn bench run --index --reset --label head --out /tmp/head.json
yarn bench compare /tmp/base.json /tmp/head.json --out /tmp/diff.md
```

The diff shows each metric with its delta, the per-type deltas, and the queries that
regressed or improved (by file MRR@10 and chunk Recall@10). It warns when the two reports
used different datasets, commits or query sets. Paste it into the PR. Run both sides on the
same machine — latency, and to a lesser degree scores, depend on hardware and quantisation.

`--reset` matters when the change affects indexing (chunking, payload, model): without it
unchanged files keep their old chunks.

## Adding or fixing queries

The dataset is `packages/bench/datasets/paparats.json`:

```json
{
  "id": "id-01",
  "type": "identifier",
  "query": "validateGroupName",
  "project": "paparats-mcp",
  "expected": [
    { "file": "packages/server/src/indexer.ts", "startLine": 55, "endLine": 67, "symbol": "validateGroupName" }
  ]
}
```

- Label by reading the code **at the dataset's `commit`**, not at your checkout. Lines are
  1-indexed and inclusive, as an editor shows them. Span the smallest unit that answers the
  query — usually the function or the statement.
- List every location the query needs. They are all required: a query with three expected
  spans scores chunk Recall@10 = 0.33 if only one is found. Don't add a "also acceptable"
  location as a second target.
- `startLine`/`endLine` can be omitted to accept any chunk of the file; `symbol` is a
  labelling aid that `validate` checks against the span.
- Only `.ts`/`.tsx`/`.js`/`.jsx` files are in the code index; never label files under
  `packages/bench/` (the bench excludes itself from the corpus).
- Keep ids stable — reports are compared by id. Add new ones at the end of their type.

Check the labels against the pinned commit:

```bash
yarn bench validate
```

It confirms every file exists at the commit, every span is inside the file and every
`symbol` appears inside its span. The unit tests (`yarn test`) only check the schema.

### Moving the dataset to a newer commit

Labels are pinned so that results stay comparable as the code moves. To re-pin: change
`commit`, run `yarn bench validate`, fix every span it reports (and re-check the ones it
does not — `validate` cannot tell that a function moved within its file if its name is
still in range), then re-run the baseline. Reports from different commits are not
comparable; `compare` warns about it.

## Adding another dataset

Any JSON file with the same schema works: `yarn bench run --dataset path/to/other.json`
(group `bench-<name>`). `projects` lists one or more directories inside the repository at
`commit` (each indexed as its own project in the bench group), and every query names its
project. The commit is exported from this repository; for a dataset over another
repository, check that repository out at the dataset commit and pass `--source <dir>`.

Not yet supported: external benchmarks such as Loc-Bench or SWE-bench Lite file
localisation. Their instances each live in a different repository at a different commit,
so they need a loader that clones and indexes one checkout per instance; that is a
follow-up.
