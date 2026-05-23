import { createEmbeddingProvider, type CachedEmbeddingProvider } from '../embeddings.js';

export interface ArchEmbeddingConfig {
  provider: 'ollama' | 'openai' | 'voyage';
  model: string;
  dimensions: number;
  apiKey?: string;
}

const DEFAULT_MODEL = 'bge-m3';
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
  return { provider: 'ollama', model, dimensions };
}

export function createArchEmbeddingProvider(config: ArchEmbeddingConfig): CachedEmbeddingProvider {
  return createEmbeddingProvider({
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    apiKey: config.apiKey,
    taskPrefixes: { enabled: false },
  });
}
