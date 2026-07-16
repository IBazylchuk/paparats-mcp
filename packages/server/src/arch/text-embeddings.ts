import { createEmbeddingProvider, type CachedEmbeddingProvider } from '../embeddings.js';

export interface ArchEmbeddingConfig {
  provider: 'llama' | 'openai' | 'voyage';
  model: string;
  dimensions: number;
  apiKey?: string;
}

const DEFAULT_MODEL = 'qwen3-embedding-0.6b';
const DEFAULT_DIMENSIONS = 1024;

export function resolveArchEmbeddingConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): ArchEmbeddingConfig {
  const explicit = env['TEXT_EMBEDDING_PROVIDER']?.trim().toLowerCase();
  const openaiKey = env['OPENAI_API_KEY']?.trim();
  const model = env['TEXT_EMBEDDING_MODEL']?.trim() || DEFAULT_MODEL;
  const dimEnv = env['TEXT_EMBEDDING_DIMENSIONS']?.trim();
  const dimensions = dimEnv ? parseInt(dimEnv, 10) : DEFAULT_DIMENSIONS;

  if (explicit === 'openai') {
    if (!openaiKey) {
      throw new Error('TEXT_EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY');
    }
    return { provider: 'openai', model, dimensions, apiKey: openaiKey };
  }
  if (explicit === 'voyage') {
    const voyageKey = env['VOYAGE_API_KEY']?.trim();
    if (!voyageKey) {
      throw new Error('TEXT_EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY');
    }
    return { provider: 'voyage', model, dimensions, apiKey: voyageKey };
  }
  return { provider: 'llama', model, dimensions };
}

export function createArchEmbeddingProvider(config: ArchEmbeddingConfig): CachedEmbeddingProvider {
  // Omit taskPrefixes so createEmbeddingProvider auto-detects by model family.
  // The arch/docs layer embeds PROSE (component/decision/lesson notes, and
  // future docs) with Qwen3-Embedding → instruction prefix enabled. Qwen has a
  // single retrieval instruction for all query types, so the code-oriented
  // query-type detection is a no-op here (every type maps to the same string).
  // An unknown/cloud model → family 'none' → prefixes off.
  return createEmbeddingProvider({
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    apiKey: config.apiKey,
  });
}
