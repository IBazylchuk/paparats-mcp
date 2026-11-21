# Retrieval bench — paparats

> Lexical baseline: Okapi BM25 over whole files of the corpus at the dataset commit, run with
> `yarn bench run --arm bm25 --label bm25-files` (in memory, no Qdrant, no embedding server;
> parameters and tokenizer are fixed, see `docs/benchmarking.md`). Chunk-level metrics do not
> apply to whole files. Compare with `paparats-f5b2a75-bge-code-v1.md`, the dense arm's baseline
> at the same dataset commit. Latency is scoring time only.

Dataset commit `f5b2a75ef47e`, 57 queries; mode `bm25-files`, Okapi BM25 k1=1.2 b=0.75, limit 10, 175 files, label `bm25-files`.
Run at 2026-11-21T18:09:20.488Z.

## Overall

| Level | R@1 | R@5 | R@10 | MRR@10 | nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| file | 0.558 | 0.901 | 0.939 | 0.727 | 0.779 |

Chunk-level metrics do not apply: this arm ranks whole files.

Latency per query: p50 0 ms, p95 1 ms, mean 0 ms.

## By query type

| Type | n | file R@1 | file R@5 | file MRR@10 | file R@10 | p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| code | 5 | 0.667 | 0.900 | 0.900 | 1.000 | 0 ms |
| config | 6 | 0.750 | 1.000 | 0.889 | 1.000 | 0 ms |
| cross-package | 6 | 0.167 | 0.472 | 0.399 | 0.667 | 0 ms |
| error | 8 | 0.750 | 1.000 | 0.844 | 1.000 | 0 ms |
| identifier | 10 | 0.200 | 1.000 | 0.528 | 1.000 | 0 ms |
| nl | 16 | 0.813 | 0.969 | 0.875 | 0.969 | 0 ms |
| where | 6 | 0.333 | 0.750 | 0.528 | 0.833 | 0 ms |

## Misses (no expected file in the top 10)

| Query | Type | Text | Top hit |
| --- | --- | --- | --- |
| where-02 | where | where are the default exclude patterns for TypeScript projects defined | `packages/server/src/types.ts:1` |
| x-06 | cross-package | how does the indexer container construct the server's Indexer library | `packages/server/src/types.ts:1` |
