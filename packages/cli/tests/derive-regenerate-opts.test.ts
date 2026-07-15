import { describe, it, expect } from 'vitest';
import { deriveRegenerateOptsFromCompose } from '../src/projects-yml.js';

describe('deriveRegenerateOptsFromCompose', () => {
  it('infers native for a legacy compose with no embed service and no EMBED_URL', () => {
    // The Ollama-era developer install: Qdrant + server in Docker, embed native
    // on the host, and a compose old enough to omit EMBED_URL entirely.
    const compose = `services:
  qdrant:
    container_name: paparats-qdrant
    image: qdrant/qdrant:latest
  paparats:
    container_name: paparats-mcp
    image: ibaz/paparats-server:latest
`;
    const opts = deriveRegenerateOptsFromCompose(compose, '/home');
    expect(opts.embedMode).toBe('native');
    expect(opts.embedUrl).toBeUndefined();
    expect(opts.qdrantUrl).toBeUndefined();
  });

  it('infers native when EMBED_URL points at host.docker.internal', () => {
    const compose = `services:
  paparats:
    container_name: paparats-mcp
    environment:
      EMBED_URL: http://host.docker.internal:11434
`;
    expect(deriveRegenerateOptsFromCompose(compose, '/home').embedMode).toBe('native');
  });

  it('infers docker when an embed service container is present', () => {
    const compose = `services:
  embed:
    container_name: paparats-embed
    image: ibaz/paparats-embed:latest
  paparats:
    container_name: paparats-mcp
`;
    expect(deriveRegenerateOptsFromCompose(compose, '/home').embedMode).toBe('docker');
  });

  it('infers external and captures the off-box URL', () => {
    const compose = `services:
  paparats:
    container_name: paparats-mcp
    environment:
      EMBED_URL: http://gpu-box.internal:11434
`;
    const opts = deriveRegenerateOptsFromCompose(compose, '/home');
    expect(opts.embedMode).toBe('external');
    expect(opts.embedUrl).toBe('http://gpu-box.internal:11434');
  });

  it('captures an external Qdrant URL when there is no qdrant container', () => {
    const compose = `services:
  paparats:
    container_name: paparats-mcp
    environment:
      QDRANT_URL: https://cloud.qdrant.io:6333
      EMBED_URL: http://host.docker.internal:11434
`;
    const opts = deriveRegenerateOptsFromCompose(compose, '/home');
    expect(opts.qdrantUrl).toBe('https://cloud.qdrant.io:6333');
  });
});
