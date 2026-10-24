# Retrieval bench — paparats

> Tier-1 baseline: dense-only search on `main`, over the corpus at the dataset commit. Measured on Apple
> silicon with a native `llama-server` (bge-code-v1 Q8_0, Metal) and Qdrant in Docker;
> latency includes the query embedding call. Absolute numbers shift with hardware, so
> compare runs made on the same machine. The JSON report is not committed — regenerate it
> with `yarn bench run --index --reset --label baseline` on the commit you compare against.
>
> History (file MRR@10 / chunk R@10): 0.767 / 0.825 at the dataset commit; 0.825 / 0.892
> after the AST chunker started merging adjacent small chunks (2275 → 1513 chunks).

Dataset commit `f5b2a75ef47e`, 57 queries; mode `search_code`, model `bge-code-v1`, group `bench-paparats`, limit 10, 1513 chunks, label `merge-small`.
Run at 2026-10-24T21:15:21.850Z.

## Overall

| Level | R@1 | R@5 | R@10 | MRR@10 | nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| file | 0.658 | 0.915 | 0.944 | 0.825 | 0.838 |
| chunk | 0.269 | 0.789 | 0.892 | 0.530 | 0.606 |

Latency per query: p50 98 ms, p95 176 ms, mean 105 ms.

## By query type

| Type | n | file R@1 | file R@5 | file MRR@10 | chunk R@10 | chunk nDCG@10 | p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| code | 5 | 0.767 | 0.933 | 1.000 | 1.000 | 0.845 | 98 ms |
| config | 6 | 0.333 | 0.667 | 0.444 | 0.667 | 0.412 | 38 ms |
| cross-package | 6 | 0.528 | 0.750 | 1.000 | 0.639 | 0.414 | 122 ms |
| error | 8 | 0.875 | 1.000 | 0.917 | 1.000 | 0.804 | 79 ms |
| identifier | 10 | 0.500 | 1.000 | 0.725 | 1.000 | 0.596 | 60 ms |
| nl | 16 | 0.781 | 1.000 | 0.896 | 0.938 | 0.637 | 124 ms |
| where | 6 | 0.667 | 0.833 | 0.741 | 0.833 | 0.461 | 97 ms |

## Misses (no expected file in the top 10)

| Query | Type | Text | Top hit |
| --- | --- | --- | --- |
| cfg-03 | config | INDEX_DOCS | `packages/server/src/indexer.ts:1283` |
| cfg-06 | config | PAPARATS_PROJECT_SUFFIX | `packages/server/tests/server.test.ts:52` |
