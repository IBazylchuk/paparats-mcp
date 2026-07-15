import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveRegenerateOptsFromCompose, readInstallState } from '../src/projects-yml.js';

describe('readInstallState legacy migration', () => {
  function withHome(json: string | null): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-install-'));
    if (json !== null) fs.writeFileSync(path.join(home, 'install.json'), json);
    return home;
  }

  it('migrates the legacy ollamaMode field to embedMode', () => {
    const home = withHome(JSON.stringify({ ollamaMode: 'native' }));
    const state = readInstallState(home);
    expect(state?.embedMode).toBe('native');
    // legacy key is dropped, not carried through
    expect((state as Record<string, unknown>).ollamaMode).toBeUndefined();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns null for a state with no usable embed mode', () => {
    const home = withHome(JSON.stringify({ somethingElse: true }));
    expect(readInstallState(home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns null when install.json is absent', () => {
    const home = withHome(null);
    expect(readInstallState(home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

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
      EMBED_URL: http://host.docker.internal:18434
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

  it('does not match EMBED_URL outside the services block (volumes/networks false positive)', () => {
    const compose = `services:
  paparats:
    container_name: paparats-mcp
    image: ibaz/paparats-server:latest
volumes:
  EMBED_URL: http://false-positive.example.com
`;
    const opts = deriveRegenerateOptsFromCompose(compose, '/home');
    // The volumes-block key must be ignored → no external URL → native.
    expect(opts.embedMode).toBe('native');
    expect(opts.embedUrl).toBeUndefined();
  });

  it('does not match QDRANT_URL outside the services block', () => {
    const compose = `services:
  paparats:
    container_name: paparats-mcp
    environment:
      EMBED_URL: http://host.docker.internal:18434
networks:
  QDRANT_URL: http://false-positive.example.com
`;
    // No qdrant container → externalQdrant true, but the URL only lives in
    // networks:, so it must not be picked up.
    expect(deriveRegenerateOptsFromCompose(compose, '/home').qdrantUrl).toBeUndefined();
  });

  it('reads a list-style env entry (- KEY=value)', () => {
    const compose = `services:
  paparats:
    container_name: paparats-mcp
    environment:
      - EMBED_URL=http://gpu-box.internal:11434
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
      EMBED_URL: http://host.docker.internal:18434
`;
    const opts = deriveRegenerateOptsFromCompose(compose, '/home');
    expect(opts.qdrantUrl).toBe('https://cloud.qdrant.io:6333');
  });
});
