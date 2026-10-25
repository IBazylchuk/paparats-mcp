# Retrieval bench — paparats

> Tier-1 baseline: `search_code` on `main`, over the corpus at the dataset commit. Measured on Apple
> silicon with a native `llama-server` (bge-code-v1 Q8_0, Metal) and Qdrant in Docker;
> latency includes the query embedding call. Absolute numbers shift with hardware, so
> compare runs made on the same machine. The JSON report is not committed — regenerate it
> with `yarn bench run --index --reset --label baseline` on the commit you compare against.
>
> History (file MRR@10 / chunk R@10): 0.767 / 0.825 at the dataset commit; 0.825 / 0.892
> after the AST chunker started merging adjacent small chunks (2275 → 1513 chunks);
> 0.900 / 0.942 in 2.12.0 (test files ranked lower, definitions of named identifiers
> first, file path in the embedded text, often-changed files slightly higher).

Dataset commit `f5b2a75ef47e`, 57 queries; mode `search_code`, model `bge-code-v1`, group `bench-paparats`, limit 10, 1513 chunks, label `baseline`.
Run at 2026-10-25T20:25:46.398Z.

## Overall

| Level | R@1 | R@5 | R@10 | MRR@10 | nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| file | 0.754 | 0.950 | 0.974 | 0.900 | 0.906 |
| chunk | 0.497 | 0.851 | 0.942 | 0.706 | 0.757 |

Latency per query: p50 81 ms, p95 209 ms, mean 100 ms.

## By query type

| Type | n | file R@1 | file R@5 | file MRR@10 | chunk R@10 | chunk nDCG@10 | p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| code | 5 | 0.567 | 1.000 | 0.900 | 1.000 | 0.819 | 137 ms |
| config | 6 | 0.500 | 0.833 | 0.694 | 0.917 | 0.669 | 71 ms |
| cross-package | 6 | 0.528 | 0.861 | 1.000 | 0.778 | 0.453 | 101 ms |
| error | 8 | 1.000 | 1.000 | 1.000 | 1.000 | 0.954 | 79 ms |
| identifier | 10 | 0.900 | 1.000 | 0.950 | 1.000 | 0.926 | 107 ms |
| nl | 16 | 0.813 | 1.000 | 0.906 | 0.938 | 0.732 | 66 ms |
| where | 6 | 0.667 | 0.833 | 0.769 | 0.917 | 0.624 | 70 ms |

## Misses (no expected file in the top 10)

None.
