/**
 * Docs layer types. The docs layer embeds long-form markdown prose (Confluence
 * exports, business/technical docs) into a separate Qdrant collection
 * (`paparats_<group>_docs`, qwen3 1024d + BM25 sparse). Distinct from the code
 * layer (AST chunks) and the arch layer (tool-authored memory).
 *
 * Chunking is structural: split by markdown heading, sub-split oversized
 * sections by paragraph. See docs/chunking-strategy.md for the research behind
 * these choices.
 */

/** A single structural chunk produced by {@link chunkMarkdown}. */
export interface DocsChunk {
  /**
   * The chunk body actually embedded. Includes the heading breadcrumb prepended
   * to the section text (see chunking-strategy.md — breadcrumb disambiguates
   * repeated subsection names). Line numbers below map to the ORIGINAL source,
   * not this (breadcrumb-augmented) text.
   */
  content: string;
  /** Heading trail from the document root to this chunk, e.g. ['Runbook', 'Deploy', 'Rollback']. */
  headingPath: string[];
  /** 0-indexed inclusive start line in the original source (matches code/AST chunker convention). */
  startLine: number;
  /** 0-indexed inclusive end line in the original source. */
  endLine: number;
  /** Order of this chunk within its document — enables auto-merge / neighbour fetch. */
  chunkIndex: number;
}

/** Options controlling the markdown chunker. All optional — defaults per chunking-strategy.md. */
export interface MarkdownChunkOptions {
  /**
   * Document title, prepended as the first breadcrumb segment. When omitted, the
   * breadcrumb starts at the first heading. Typically the Confluence page title.
   */
  docTitle?: string;
  /**
   * Target chunk size in TOKENS (approximate — we count with a cheap heuristic,
   * not the model tokenizer). Research sweet spot 200–400. Default 320.
   */
  targetTokens?: number;
  /**
   * Hard ceiling before a section is force-split even mid-paragraph. Default
   * targetTokens * 1.5. Guards against a single monster paragraph.
   */
  maxTokens?: number;
}

/** A docs search hit: the stored chunk payload plus the fused (RRF) relevance score. */
export interface DocsSearchHit {
  docId: string;
  docTitle: string;
  headingPath: string[];
  sourceUrl: string | null;
  file: string;
  project: string;
  chunkIndex: number;
  content: string;
  startLine: number;
  endLine: number;
  /** Fused score from RRF over dense + sparse prefetch. Not a raw cosine. */
  score: number;
}
