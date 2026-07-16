# Replacing embedding models

How to swap the code and/or docs embedding model in paparats — a reproducible
checklist distilled from the jina-code/bge-m3 → bge-code-v1/Qwen3-Embedding
migration. Follow it in order; the ordering matters (verify the model in
isolation **before** wiring it into defaults, and reindex **after**).

paparats has **two independent embedding layers**, each with its own Qdrant
collection, model, and dimension — they never mix:

| Layer | Collection | Default model | Dim | Pooling | License | Content |
| --- | --- | --- | --- | --- | --- | --- |
| Code | `paparats_<group>` | `bge-code-v1` | 1536 | last | Apache-2.0 | code chunks |
| Arch/docs | `paparats_<group>_arch` | `qwen3-embedding-0.6b` | 1024 | last | Apache-2.0 | prose (arch notes, future docs) |

Swapping the code model and the docs model are independent operations — this
checklist applies to either; just follow the column for the layer you're
changing. Both models are baked into the `ibaz/paparats-embed` image and
downloaded natively by `paparats install --embed-mode native` (Metal on macOS,
faster than the CPU container and the recommended local path).

---

## 0. Pick a model — non-negotiable constraints

- **Permissive license only** (MIT / Apache-2.0 / BSD). CC-BY-NC (jina) is out
  for commercial/enterprise adoption.
- **A GGUF build must exist** (llama.cpp serves GGUF). Search HF for
  `<model>-GGUF`; Q8_0 is the quality/size sweet spot we use.
- **Prefer decoder/LLM-based embedders** (bge-code-v1, Qwen3) — they use
  **last-token pooling**, and llama.cpp supports `--pooling last`. Confirm the
  pooling the model card prescribes; wrong pooling silently corrupts the vector
  space (see step 3).
- **Benchmark on a real retrieval set before committing** — vendor/marketing
  numbers are not evidence. Use BEIR-format datasets (code: CoIR/CosQA; prose:
  SciFact/FiQA) and measure nDCG@5 / Recall@5 with brute-force cosine. Do NOT
  trust "our tests show +X%" from a model page.

## 1. Bake / download the GGUF

- **Docker embed image** — `packages/embed/Dockerfile`: add a `RUN curl ...`
  layer for the new GGUF (one layer per model so a bump re-pushes only that
  layer). Update the header comment listing the baked models.
- **Native install** — `packages/cli/src/commands/install.ts`: update
  `CODE_MODEL_NAME` / `CODE_GGUF_URL` / `CODE_GGUF_FILE` (or the `TEXT_*`
  equivalents), the download-progress labels, and the pooling comment.
- **llama-swap routing** — `packages/embed/llama-swap.template.yaml` (docker)
  **and** the `renderLlamaSwapConfig()` string in `install.ts` (native): add a
  `models:` entry with the correct `--pooling`. Both must agree.

## 2. Wire the new model name into the code paths

Every place that hard-codes the old default (grep the old name across
`packages/` excluding `CHANGELOG.md`, which is history and stays as-is):

| Where | What |
| --- | --- |
| `packages/server/src/config.ts` | `DEFAULT_EMBEDDINGS.model`, `MODEL_DIMENSIONS` row |
| `packages/server/src/embeddings.ts` | `LlamaServerProviderConfig` default model, `resolveEmbeddingConfigFromEnv` default, header comment |
| `packages/server/src/arch/text-embeddings.ts` | `DEFAULT_MODEL` (docs/arch text) |
| `packages/cli/src/docker-compose-generator.ts` | `TEXT_EMBEDDING_MODEL:-<default>` |
| `packages/cli/src/commands/status.ts`, `doctor.ts` | default model-name fallbacks |
| `packages/server/src/task-prefixes.ts` | `modelFamily()` mapping + instruction (see step 4) |

`createEmbeddingProvider` auto-enables instruction prefixes when
`modelFamily(model) !== 'none'`, so a new instruction-tuned family must be added
to `modelFamily()` or its prefixes won't fire.

## 3. Cosine-smoke the model IN ISOLATION (mandatory)

Before touching defaults, confirm the GGUF + pooling produce a sane vector
space. Start llama-swap with the new model and check, via `/v1/embeddings`:

- **Correct dimension** (matches the model card).
- **Not all-zero** — decoder embedders can silently return zero vectors if the
  tokenizer drops the EOS token (llama.cpp bug #14234 hit Qwen3 in some builds).
- **`cos(x, x) ≈ 1.0`** for identical input.
- **`cos(related) > cos(unrelated)`** — basic geometry.

Cosine-verify against the reference (sentence-transformers) output if you can —
a mismatch means wrong pooling. A reference smoke script lives in the migration
notes; keep it ~20 lines and model-agnostic.

## 4. Instruction prefixes — use the VERBATIM task string from the model card

This is the single biggest footgun and cost the most time in the last
migration. Instruction-tuned embedders (bge-code-v1, Qwen3) wrap the **query**
(not documents — retrieval is asymmetric) in a task instruction. Three rules:

1. **Template** is family-specific — encoded in `formatInstruction()`:
   - bge-code: `<instruct>{task}\n<query>{query}`
   - qwen: `Instruct: {task}\nQuery:{query}`
2. **Task string must be copied VERBATIM from THAT model's OWN card.** A
   hand-written instruction is out-of-distribution and measurably degrades
   retrieval — on a real repo a paraphrased string shifted the entire top-5 and
   dropped cosine ~0.15, while the card's exact string matched the production
   baseline. Never reuse one family's string for another family. Copy
   punctuation as-is (BAAI ends with a period, Qwen doesn't — that's verbatim,
   not a typo). Strings live in `TASK_INSTRUCTION` (`task-prefixes.ts`) keyed by
   `family → queryType`, each with its source task name cited.
3. **A model may not have a string for every query type.** bge-code's card has a
   per-task dict (CosQA → nl2code, CodeTrans-DL → code2code, StackOverFlow-QA →
   techqa). Qwen has a single retrieval instruction, so all three query types
   map to the same string — the code-oriented query-type detection is a no-op
   for the prose/docs layer. Don't invent a per-task string a card doesn't ship.

Documents are always embedded unprefixed (`prefixPassage` returns the passage
unchanged) — do not add a document instruction.

## 5. Verify end-to-end on OUR data, not synthetic queries

Stand up the real path — native llama-swap (Metal) + Qdrant + server — index a
real repo, and compare against the current production index (same repo is
already indexed there). Confirm the new model's top-1 for realistic queries
matches or beats the incumbent. Out-of-corpus queries measure noise; pick
queries whose answers actually exist in the repo.

## 6. Reindex — BOTH layers, and they reindex differently

A model change invalidates every vector in that layer. The two layers are
reindexed by completely different mechanisms — **don't forget the arch layer.**

- A collection stores `model` + `dimensions` in its `__meta` point; a mismatch
  throws `CollectionMetaMismatchError` (`indexer.ts`). You **cannot** mix
  old-model and new-model vectors — even at the same dimension the vector spaces
  are incompatible (verified: a bge-m3 vector vs the qwen vector of the same
  text has cosine ≈ 0).
- The vector cache (SQLite at `~/.paparats/cache/embeddings.db`) is keyed by
  `(hash, model)`, so a model change is a clean cache miss — no poisoning. Old
  rows become dead weight; prune them if disk matters.

**Code layer** (`paparats_<group>`) — rebuilt from source:

- **OSS / self-hosted:** reindex on the next indexer cycle (drop the old
  collection so it rebuilds; bump `REINDEX_EPOCH` in the indexer to force it).
- **Shared remote Qdrant (single instance):** blue-green via a **new
  collection** — index into it in parallel, cut over when full, drop the old
  one. Never dual-run two Qdrants.

**Arch/docs layer** (`paparats_<group>_arch`) — re-embedded IN PLACE:

- Arch memory has no source to re-walk — it's only ever written by the
  `arch_record_*` tools. Nothing else re-embeds it, so a model swap leaves it
  stranded in the old model's space (or dimension-incompatible).
- Trigger the dedicated pass per group: `POST /api/arch/reindex {"group":"..."}`.
  It reads each card's payload, reconstructs the embedding text with the same
  renderers used on write, re-embeds with the current text model, and rewrites
  in place (dropping/recreating the collection only if the dimension changed).
  Arch collections are tiny, so this is fast.
- Easy to forget because it isn't automatic — put it in the cutover runbook next
  to the code reindex.

## 7. Docs + changeset

- Update model names/dims in `packages/server/README.md`,
  `packages/embed/README.md`, and this table if the defaults changed.
- Record benchmark numbers + methodology in the README (they're reusable
  evidence for the next migration).
- Add a changeset (`yarn changeset`) — releases are Changesets `fixed` mode;
  never bump versions by hand.
