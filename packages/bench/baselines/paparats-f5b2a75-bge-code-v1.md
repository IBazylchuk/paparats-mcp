# Retrieval bench — paparats

> Tier-1 baseline: dense-only search as shipped at the dataset commit. Measured on Apple
> silicon with a native `llama-server` (bge-code-v1 Q8_0, Metal) and Qdrant in Docker;
> latency includes the query embedding call. Absolute numbers shift with hardware, so
> compare runs made on the same machine. The JSON report is not committed — regenerate it
> with `yarn bench run --index --reset --label baseline` on the commit you compare against.

Dataset commit `f5b2a75ef47e`, 57 queries; mode `search_code`, model `bge-code-v1`, group `bench-paparats`, limit 10, 2275 chunks, label `baseline`.
Run at 2026-10-24T19:28:42.608Z.

## Overall

| Level | R@1 | R@5 | R@10 | MRR@10 | nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| file | 0.579 | 0.880 | 0.901 | 0.767 | 0.779 |
| chunk | 0.260 | 0.702 | 0.825 | 0.485 | 0.549 |

Latency per query: p50 81 ms, p95 123 ms, mean 81 ms.

## By query type

| Type | n | file R@1 | file R@5 | file MRR@10 | chunk R@10 | chunk nDCG@10 | p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| code | 5 | 0.567 | 0.567 | 0.800 | 0.633 | 0.650 | 74 ms |
| config | 6 | 0.500 | 0.667 | 0.556 | 0.667 | 0.437 | 30 ms |
| cross-package | 6 | 0.278 | 0.806 | 0.833 | 0.639 | 0.346 | 108 ms |
| error | 8 | 0.875 | 1.000 | 0.900 | 1.000 | 0.790 | 72 ms |
| identifier | 10 | 0.400 | 1.000 | 0.653 | 1.000 | 0.553 | 62 ms |
| nl | 16 | 0.719 | 0.969 | 0.865 | 0.813 | 0.548 | 87 ms |
| where | 6 | 0.500 | 0.833 | 0.639 | 0.833 | 0.458 | 77 ms |

## Misses (no expected file in the top 10)

| Query | Type | Text | Top hit |
| --- | --- | --- | --- |
| cfg-03 | config | INDEX_DOCS | `packages/server/src/indexer.ts:1283` |
| cfg-06 | config | PAPARATS_PROJECT_SUFFIX | `packages/server/src/indexer.ts:271` |
| where-01 | where | where is the default Qdrant URL configured | `packages/cli/src/commands/doctor.ts:50` |
| code-03 | code | function overlaps(aStart: number, aEnd: number, bStart: number, bEn... | `packages/server/src/chunker.ts:33` |

## Observations

- **Exact identifiers and config keys rank low.** Every `identifier` query finds its file in
  the top 5 (file R@5 1.000) but only 40% at rank 1 (file MRR@10 0.653), and two of the six
  `config` queries (bare environment-variable names) miss entirely — the dense-only weakness
  the hybrid BM25 work is meant to fix. These are the rows it should move.
- **Trivial chunks crowd the results.** 577 of the 2275 chunks are a single line, 35 of them
  a lone `}`. In `search_code` mode identical `}` chunks collapse under the content-hash
  dedupe, so `code-03` returned 4 results instead of 10.
- **Query expansion costs latency without a measurable gain here.** Against plain `search`
  mode (`--mode search`), `search_code`'s expansion moves file MRR@10 by −0.012 and chunk
  R@10 by +0.018 while raising p50 latency from 48 to 81 ms.
