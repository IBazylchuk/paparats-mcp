import { describe, it, expect } from 'vitest';
import {
  createArchEmbeddingProvider,
  resolveArchEmbeddingConfig,
} from '../../src/arch/text-embeddings.js';

describe('resolveArchEmbeddingConfig', () => {
  it('defaults to llama + qwen3-embedding-0.6b + 1024 dims', () => {
    const cfg = resolveArchEmbeddingConfig({});
    expect(cfg.provider).toBe('llama');
    expect(cfg.model).toBe('qwen3-embedding-0.6b');
    expect(cfg.dimensions).toBe(1024);
  });

  it('honours TEXT_EMBEDDING_MODEL and TEXT_EMBEDDING_DIMENSIONS', () => {
    const cfg = resolveArchEmbeddingConfig({
      TEXT_EMBEDDING_MODEL: 'custom-text',
      TEXT_EMBEDDING_DIMENSIONS: '768',
    });
    expect(cfg.model).toBe('custom-text');
    expect(cfg.dimensions).toBe(768);
  });

  it('uses OPENAI_API_KEY when TEXT_EMBEDDING_PROVIDER=openai', () => {
    const cfg = resolveArchEmbeddingConfig({
      TEXT_EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(cfg.provider).toBe('openai');
    expect(cfg.apiKey).toBe('sk-test');
  });

  it('throws when openai requested without an API key', () => {
    expect(() => resolveArchEmbeddingConfig({ TEXT_EMBEDDING_PROVIDER: 'openai' })).toThrow(
      /OPENAI_API_KEY/
    );
  });

  it('uses VOYAGE_API_KEY when TEXT_EMBEDDING_PROVIDER=voyage', () => {
    const cfg = resolveArchEmbeddingConfig({
      TEXT_EMBEDDING_PROVIDER: 'voyage',
      VOYAGE_API_KEY: 'vk-test',
    });
    expect(cfg.provider).toBe('voyage');
    expect(cfg.apiKey).toBe('vk-test');
  });

  it('throws when voyage requested without an API key', () => {
    expect(() => resolveArchEmbeddingConfig({ TEXT_EMBEDDING_PROVIDER: 'voyage' })).toThrow(
      /VOYAGE_API_KEY/
    );
  });
});

describe('createArchEmbeddingProvider', () => {
  it('builds a CachedEmbeddingProvider for the text model with prefixes disabled', () => {
    const provider = createArchEmbeddingProvider({
      provider: 'llama',
      model: 'bge-m3',
      dimensions: 1024,
    });
    expect(provider.model).toBe('bge-m3');
    expect(provider.dimensions).toBe(1024);
    expect(provider.prefixesEnabled).toBe(false);
    provider.close();
  });
});
