# Embedding models

Paparats embeds code and prose separately: code with a code model, architectural memory,
docs and the glossary with a text model. Both run locally by default; a cloud provider
can take both.

| Provider   | Code model               | Dims | Text model             | Where your code goes |
| ---------- | ------------------------ | ---- | ---------------------- | -------------------- |
| **llama** (default) | `bge-code-v1`   | 1536 | `qwen3-embedding-0.6b` | nowhere, it stays local |
| **Voyage** | `voyage-code-3`          | 1024 | `voyage-4`             | sent to Voyage AI    |
| **OpenAI** | `text-embedding-3-small` | 1536 | `text-embedding-3-small` | sent to OpenAI     |

```bash
paparats install --embeddings voyage --embedding-api-key pa-...
paparats install --embeddings openai --embedding-api-key sk-...
paparats install --embeddings llama                 # back to local
```

The choice is fixed per Qdrant collection: changing the provider or the model means
indexing everything again, and the server refuses to mix them in one collection. Another
model of the same provider goes into `~/.paparats/.env`: `EMBEDDING_MODEL` and
`EMBEDDING_DIMENSIONS` for code (for example `EMBEDDING_MODEL=voyage-code-4`),
`TEXT_EMBEDDING_MODEL` and `TEXT_EMBEDDING_DIMENSIONS` for prose. `voyage-code-3` takes
256, 512, 1024 or 2048 dimensions.

On a deployment without the CLI, the server and the indexer read `EMBEDDING_PROVIDER`
(`llama`, `openai`, `voyage`). Without it: `OPENAI_API_KEY` set means OpenAI,
`VOYAGE_API_KEY` set means Voyage, otherwise llama. The prose provider is not guessed:
it stays llama unless `TEXT_EMBEDDING_PROVIDER` is set, together with
`TEXT_EMBEDDING_MODEL` and `TEXT_EMBEDDING_DIMENSIONS` (the generated compose sets all
three for a cloud provider).

## Local models

[BAAI/bge-code-v1](https://huggingface.co/BAAI/bge-code-v1) for code and
[Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) for prose, both
Apache-2.0, as Q8_0 GGUF files (1.6 GB and 0.6 GB). They are served by llama.cpp
`llama-server` behind `llama-swap`, which routes by model name and loads a model on its
first request. There is no model registration step.

- **Native** (`--embed-mode native`, the macOS default): `paparats install` installs
  `brew install llama.cpp mostlygeek/llama-swap/llama-swap` (Metal), downloads the GGUF
  files to `~/.paparats/models/` and serves them on port 18434.
- **Docker** (`--embed-mode docker`, the Linux default): the `ibaz/paparats-embed` image
  has both models built in.

By hand:

```bash
docker run -d -p 18434:8080 ibaz/paparats-embed:latest
curl http://localhost:18434/health
curl http://localhost:18434/v1/models
```

`bge-code-v1` is served with an 8,192-token context (the model takes 32k). Each query is
wrapped in the instruction its model card gives for the kind of query; documents are
embedded without one. A paraphrased instruction measurably hurts retrieval, so they are
copied word for word. Replacing either model has more traps like that:
[replacing-embedding-models.md](replacing-embedding-models.md).

## How the models were chosen

Each candidate was served by `llama-server` (Q8_0 GGUF) and queried through
`/v1/embeddings`, the same path the server uses. The whole corpus was embedded, every query
searched by brute-force cosine, and nDCG and Recall at K computed against the dataset's
published relevance labels. Each model used its own query instruction and its
architecture's pooling. No reranking: an agent reads the whole top K, so recall matters
more than exact order. Measured on Apple silicon (Metal); absolute values shift with
hardware, quantisation and corpus, the order between models is what decided.

**Code**: CoIR CosQA (20,604 code documents, 500 queries)

| Model | License | Dim | Recall@5 | nDCG@5 | Recall@10 |
| ----- | ------- | --- | -------- | ------ | --------- |
| **BAAI/bge-code-v1** | Apache-2.0 | 1536 | **0.480** | **0.323** | **0.722** |
| jinaai/jina-code-embeddings-1.5b | CC-BY-NC | 1536 | 0.408 | 0.269 | 0.626 |

**Prose**: SciFact (5,183 documents, 300 queries)

| Model | License | Dim | Recall@5 | nDCG@5 | Recall@10 |
| ----- | ------- | --- | -------- | ------ | --------- |
| jinaai/jina-embeddings-v3 + retrieval LoRA | CC-BY-NC | 1024 | 0.795 | 0.709 | 0.843 |
| **Qwen/Qwen3-Embedding-0.6B** | Apache-2.0 | 1024 | 0.775 | 0.681 | 0.831 |
| BAAI/bge-m3 | MIT | 1024 | 0.720 | 0.625 | 0.783 |

**Prose**: FiQA, business and finance (16.7k-document sample, 648 queries)

| Model | License | Dim | Recall@5 | nDCG@5 | Recall@10 |
| ----- | ------- | --- | -------- | ------ | --------- |
| **Qwen/Qwen3-Embedding-0.6B** | Apache-2.0 | 1024 | **0.575** | **0.555** | **0.666** |
| BAAI/bge-m3 | MIT | 1024 | 0.499 | 0.496 | 0.596 |

- For code, `bge-code-v1` finds the right document in the top 5 for 48% of queries against
  41% for `jina-code-embeddings`, has a permissive license and the same dimensions.
- For prose, Qwen3 beats `bge-m3` by 5–8 points of Recall@5, more on business text, at
  about twice the indexing time on CPU. `jina-embeddings-v3` scores highest but its
  non-commercial license rules it out.
- A cross-encoder reranker (`bge-reranker-v2-m3`) added 4–6 points of nDCG but took about
  2.7 s per query on CPU, and mostly reordered rather than found more.
- Late chunking was rejected: decoder models such as Qwen3 cannot do it, and it hurts
  documents that cover several topics. Chunking by structure matters more than the model
  ([chunking-strategy.md](chunking-strategy.md)).

These compare the models alone. `yarn bench` scores the whole search (chunking,
instructions, ranking) on a hand-labelled query set over this repository, by kind of
query; how to run and compare it is in [benchmarking.md](benchmarking.md).
