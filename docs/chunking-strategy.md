# Chunking strategy for markdown documentation

Research-backed decision record for how paparats chunks **long-form markdown
documentation** (Confluence exports, business/technical docs) before embedding
it into the docs vector layer. This is distinct from code chunking (AST-based,
see `ast-chunker.ts`) — docs are prose, split structurally.

> Scope: the docs layer embeds prose with **Qwen3-Embedding-0.6B** (1024d,
> `--pooling last`, decoder/causal). That model choice constrains which chunking
> techniques are even *possible* — see "Late chunking" below.

## TL;DR — recommended pipeline

**Header-aware structural split → recursive sub-split of oversized sections →
heading-breadcrumb prepend.** A two-stage pipeline, which is where essentially
every serious 2024–2026 source converges for documents that already carry
structure (markdown headings).

1. **Primary split by markdown heading** (H1/H2/H3…) into sections — respect the
   source's natural structural units.
2. **Secondary split** of oversized sections recursively by paragraph, targeting
   **~200–400 tokens** per chunk.
3. **Overlap = 0** (or a very small ≤30-token overlap *within* a section, never
   across a heading boundary).
4. **Prepend the heading breadcrumb** (`Doc Title > H1 > H2`) to each chunk's
   embedded text.

Rejected: semantic chunking, late chunking, LLM contextual retrieval (details
and evidence below).

## Parameters

| Parameter | Recommendation | Evidence strength |
| --------- | -------------- | ----------------- |
| Primary split | By markdown heading into sections | Practitioner consensus + HiChunk category. Not independently benchmarked as *superior* to flat splitting in the Chroma study (which did not test structural splitters). |
| Secondary split | Recursive/paragraph, ~200 tokens | Chroma: 200-token recursive splitting ≈ 88.1% recall, near-best in their sweep. |
| Chunk size | 200–400 tokens for prose | Chroma: 200–400 token range performed best; consistent with general RAG literature. |
| Overlap | **0** (≤30 tokens within a section max, never across headings) | Chroma: no-overlap matched or beat overlapping variants. Contradicts the older "always 10–20% overlap" advice. |
| Heading breadcrumb | Prepend `Doc > H1 > H2` to embedded text | Near-zero cost (string concat, no LLM). Mechanism (disambiguating repeated subsection names like "Retention" under different parents) is sound; **no rigorous controlled benchmark found** — treat as low-cost, high-plausibility, not proven. |

## Evidence base

Ranked most- to least-rigorous:

1. **Chroma — "Evaluating Chunking Strategies for Retrieval"** (Smith &
   Troynikov, Chroma Technical Report, July 2024). The most rigorous,
   independently reproducible benchmark found. Token-level recall/precision/IoU,
   `text-embedding-3-large`, 200–800 token range.
   - `RecursiveCharacterTextSplitter` @ 200 tokens, no overlap: **88.1% recall**,
     7.0% precision.
   - `ClusterSemanticChunker` @ 200 tokens: 87.3% recall, 8.0% precision (best
     precision) — i.e. semantic chunking **barely moved the needle** over
     recursive.
   - `LLMSemanticChunker` (GPT-4o-directed): **91.9% recall** (best) but 3.9%
     precision (worst) and an LLM call per document.
   - Spread between best/worst strategy: up to **9 points of recall** on the same
     corpus/retriever/embedder — chunking is a real, measurable lever.
   - Own conclusion: small chunks (~200 tokens), **no overlap**, perform
     surprisingly well; overlap did not reliably help.
   - **Caveat:** did NOT test markdown/structural chunking as a category — all
     strategies were generic text splitters. Do not over-read "recursive beats
     semantic" as "recursive beats structural."
   - <https://research.trychroma.com/evaluating-chunking> ·
     code: <https://github.com/brandonstarxel/chunking_evaluation>

2. **NVIDIA — "Finding the Best Chunking Strategy for Accurate AI Responses"**
   (2024). 7 strategies × 5 datasets including long-form business docs and
   financial reports. **Page-level chunking won on paginated documents** (most
   consistent). Directly relevant caveat: page-level applies only to *paginated*
   sources (PDF) — it does **not** transfer to markdown/HTML/plain text, which is
   exactly the Confluence-export case. Argues for "respect the source's natural
   structural units" generally; the specific technique doesn't port.
   - <https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/>

3. **HiChunk** (arXiv 2509.11552, 2025). On-topic (hierarchical/markdown-
   structure chunking): fine-tuned-LLM hierarchical structuring + "Auto-Merge"
   retrieval, introduces the HiCBench benchmark specifically because the authors
   argue existing chunking evals are inadequate. Directional support for
   header-aware chunking as a distinct, actively-researched category. Specific
   percentages **unverified** here (PDF tables not extracted).
   - <https://arxiv.org/abs/2509.11552>

4. **Practitioner consensus** (LangChain docs, multiple 2024–2026 roundups):
   split by markdown headers first (`MarkdownHeaderTextSplitter`), then run
   `RecursiveCharacterTextSplitter` only on oversized sections, keeping header
   metadata per chunk. Commonly cited config: chunk_size=250, chunk_overlap=30.
   **Engineering convention, not a benchmarked result.**
   - <https://python.langchain.com/docs/how_to/markdown_header_metadata_splitter/>

## Verdicts on the fancier techniques

**Semantic chunking (embedding-similarity boundary detection) — not worth it here.**
Chroma's own semantic chunkers did not decisively beat recursive/token splitting
(87.3% vs 88.1% recall). The only clear win was LLM-directed chunking (expensive,
worst precision). Our corpus already has strong native structure (markdown
headings from Confluence), so similarity-based boundary detection solves a problem
structural splitting already solves for free. More justified for *unstructured*
plain-text corpora — which we explicitly reject (docs must be markdown).

**Contextual Retrieval (Anthropic — LLM-generated context prepended per chunk) —
real gains, wrong fit right now.**
Anthropic report: top-20 retrieval failure 5.7% → 3.7% (contextual embeddings,
−35%) → 2.9% (+ contextual BM25, −49%) → 1.9% (+ reranking, −67%). One-time
ingestion cost, low with prompt caching. But: (a) their benchmark corpus was
*codebases*, not long-form docs, so the specific percentages aren't proven for
prose; (b) it requires an **LLM call per chunk at index time**, which breaks the
fully self-hosted architecture (our embed stack is llama.cpp, no external LLM in
the indexing path). **Deferred as an optional prototype**, not adopted.
- <https://www.anthropic.com/news/contextual-retrieval>

**Heading-breadcrumb prepending — do it anyway.**
Every practitioner source recommends it as essentially free and directionally
beneficial. But the evidence is weak: the one blog specifically proposing it
gives zero quantitative eval, and dsRAG's "Contextual Chunk Headers" numbers
(27.9% avg increase; FinanceBench 83% vs 19%) are **vendor-reported, self-graded
by GPT-4o, with different models between baseline and their system** — treat as
marketing-adjacent. Given near-zero marginal cost (string concat, no LLM) and a
sound mechanism (disambiguating polysemous section titles), we prepend the
breadcrumb regardless of the thin evidence base.

## Late chunking — rejected, confirmed twice

Late chunking (Jina) embeds the whole document first, then pools token embeddings
per chunk *after the fact*. This requires **mean pooling over a long-context,
bidirectional/full-attention** model. It is architecturally **incompatible with
decoder-only, causal-attention, last-token-pooling models like
Qwen3-Embedding-0.6B**: last-token pooling reads only the final position's
representation and offers no mechanism to retroactively pool an arbitrary token
span.
- Original paper: <https://arxiv.org/abs/2409.04701>
- Independent corroboration: Jina's own newer last-token decoder model
  (jina-embeddings-v5-text-small) explicitly does **not** support Jina's own
  late-chunking technique — i.e. even Jina can't late-chunk a last-token model.

Our prior rejection (see `EMBEDDING-MIGRATION-PLAN.local.md`) is correct and now
doubly confirmed.

## What changed vs. older advice (2023-era tutorials)

- **Overlap is less valuable than assumed.** No-overlap configs matched or beat
  overlapping ones (Chroma) — contradicts the once-universal "always use 10–20%
  overlap."
- **Semantic chunking is not a clear upgrade** over simple splitting, despite
  being marketed as the "smart" technique — only expensive LLM-directed chunking
  showed a clear recall gain, at a precision cost.
- **Respect the source's structural units** when it has them (headings for
  markdown, pages for PDF) rather than ignoring structure for fixed character
  counts.

## Notes on evidence quality

- **Measured, independent:** Chroma (token-level metrics, reproducible code).
- **Measured, vendor:** NVIDIA (own benchmark, but broad and multi-dataset);
  Anthropic Contextual Retrieval (own corpus, codebases not docs).
- **Marketing-adjacent (do not trust as evidence):** dsRAG CCH numbers
  (self-graded, mismatched baselines).
- **Convention, not measured:** LangChain's chunk=250/overlap=30 defaults.
