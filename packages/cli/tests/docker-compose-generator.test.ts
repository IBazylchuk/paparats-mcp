import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { generateCompose } from '../src/docker-compose-generator.js';

interface ComposeFile {
  services: Record<string, Record<string, unknown>>;
  volumes: Record<string, unknown>;
  networks: Record<string, unknown>;
}

function parseCompose(output: string): ComposeFile {
  return yaml.load(output) as ComposeFile;
}

const HOME = '/Users/ilya/.paparats';

describe('generateCompose', () => {
  it('emits qdrant + paparats + indexer for embedMode=native (no docker embed)', () => {
    const out = generateCompose({ embedMode: 'native', paparatsHome: HOME });
    const compose = parseCompose(out);

    expect(compose.services['qdrant']).toBeDefined();
    expect(compose.services['paparats']).toBeDefined();
    expect(compose.services['paparats-indexer']).toBeDefined();
    expect(compose.services['embed']).toBeUndefined();

    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['EMBED_URL']).toBe('http://host.docker.internal:18434');
  });

  it('emits embed service for embedMode=docker and wires depends_on', () => {
    const out = generateCompose({ embedMode: 'docker', paparatsHome: HOME });
    const compose = parseCompose(out);

    expect(compose.services['embed']).toBeDefined();
    expect(compose.services['embed']!['image']).toBe('ibaz/paparats-embed:latest');
    expect(compose.services['embed']!['container_name']).toBe('paparats-embed');
    const paparatsDeps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
    const indexerDeps = compose.services['paparats-indexer']!['depends_on'] as Record<
      string,
      unknown
    >;
    expect(paparatsDeps['embed']).toBeDefined();
    expect(indexerDeps['embed']).toBeDefined();

    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['EMBED_URL']).toBe('http://embed:8080');
  });

  it('uses provided EMBED_URL for embedMode=external', () => {
    const out = generateCompose({
      embedMode: 'external',
      embedUrl: 'http://10.0.0.5:11434',
      paparatsHome: HOME,
    });
    const compose = parseCompose(out);

    expect(compose.services['embed']).toBeUndefined();
    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['EMBED_URL']).toBe('http://10.0.0.5:11434');
  });

  it('throws when embedMode=external and embedUrl missing', () => {
    expect(() => generateCompose({ embedMode: 'external', paparatsHome: HOME })).toThrow(
      /embedUrl/
    );
  });

  it('omits qdrant service when qdrantUrl is set', () => {
    const out = generateCompose({
      embedMode: 'native',
      qdrantUrl: 'http://my-qdrant:6333',
      paparatsHome: HOME,
    });
    const compose = parseCompose(out);

    expect(compose.services['qdrant']).toBeUndefined();
    expect(compose.volumes['qdrant_data']).toBeUndefined();
    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['QDRANT_URL']).toBe('http://my-qdrant:6333');
    const deps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
    expect(deps['qdrant']).toBeUndefined();
  });

  it('propagates qdrantApiKey env var into both server and indexer', () => {
    const out = generateCompose({
      embedMode: 'native',
      qdrantUrl: 'http://my-qdrant:6333',
      qdrantApiKey: 'sekret',
      paparatsHome: HOME,
    });
    const compose = parseCompose(out);

    const paparatsEnv = compose.services['paparats']!['environment'] as Record<string, string>;
    const indexerEnv = compose.services['paparats-indexer']!['environment'] as Record<
      string,
      string
    >;
    expect(paparatsEnv['QDRANT_API_KEY']).toBe('${QDRANT_API_KEY}');
    expect(indexerEnv['QDRANT_API_KEY']).toBe('${QDRANT_API_KEY}');
  });

  it('mounts paparatsHome as /config (directory bind-mount, not single file)', () => {
    const out = generateCompose({ embedMode: 'native', paparatsHome: HOME });
    const compose = parseCompose(out);
    const volumes = compose.services['paparats-indexer']!['volumes'] as string[];
    expect(volumes).toContain(`${HOME}:/config:ro`);
  });

  it('adds bind-mount per local project', () => {
    const out = generateCompose({
      embedMode: 'native',
      paparatsHome: HOME,
      localProjects: [
        { name: 'billing', hostPath: '/Users/alice/code/billing' },
        { name: 'web', hostPath: '/Users/alice/code/web' },
      ],
    });
    const compose = parseCompose(out);
    const volumes = compose.services['paparats-indexer']!['volumes'] as string[];
    expect(volumes).toContain('/Users/alice/code/billing:/projects/billing:ro');
    expect(volumes).toContain('/Users/alice/code/web:/projects/web:ro');
  });

  it('emits no extra mounts when localProjects is empty', () => {
    const out = generateCompose({
      embedMode: 'native',
      paparatsHome: HOME,
      localProjects: [],
    });
    const compose = parseCompose(out);
    const volumes = compose.services['paparats-indexer']!['volumes'] as string[];
    const projectMounts = volumes.filter((v) => v.includes('/projects/'));
    expect(projectMounts).toEqual([]);
  });

  it('output is valid YAML with header comment', () => {
    const out = generateCompose({ embedMode: 'native', paparatsHome: HOME });
    expect(out).toContain('# paparats-mcp');
    const compose = parseCompose(out);
    expect(compose.services).toBeDefined();
    expect(compose.services['paparats-indexer']).toBeDefined();
  });

  it('honors port overrides', () => {
    const out = generateCompose({
      embedMode: 'docker',
      paparatsHome: HOME,
      ports: { qdrant: 7333, paparats: 8876, embed: 12434, indexer: 9999 },
    });
    const compose = parseCompose(out);
    expect((compose.services['qdrant']!['ports'] as string[])[0]).toContain('7333');
    expect((compose.services['paparats']!['ports'] as string[])[0]).toContain('8876');
    expect((compose.services['embed']!['ports'] as string[])[0]).toContain('12434');
    expect((compose.services['paparats-indexer']!['ports'] as string[])[0]).toContain('9999');
  });

  it('default cron set when not provided', () => {
    const out = generateCompose({ embedMode: 'native', paparatsHome: HOME });
    const compose = parseCompose(out);
    const env = compose.services['paparats-indexer']!['environment'] as Record<string, string>;
    expect(env['CRON']).toContain('0 */6 * * *');
  });

  it('custom cron override', () => {
    const out = generateCompose({ embedMode: 'native', paparatsHome: HOME, cron: '*/15 * * * *' });
    const compose = parseCompose(out);
    const env = compose.services['paparats-indexer']!['environment'] as Record<string, string>;
    expect(env['CRON']).toContain('*/15 * * * *');
  });

  describe('embeddingProvider', () => {
    it('skips the embed service entirely for embeddingProvider=openai', () => {
      const out = generateCompose({
        embedMode: 'docker',
        embeddingProvider: 'openai',
        paparatsHome: HOME,
      });
      const compose = parseCompose(out);

      expect(compose.services['embed']).toBeUndefined();

      const paparatsDeps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
      expect(paparatsDeps['embed']).toBeUndefined();

      const indexerDeps = compose.services['paparats-indexer']!['depends_on'] as Record<
        string,
        unknown
      >;
      expect(indexerDeps['embed']).toBeUndefined();
    });

    it('sets EMBEDDING_PROVIDER and OPENAI_API_KEY on both services for openai', () => {
      const out = generateCompose({
        embedMode: 'docker',
        embeddingProvider: 'openai',
        paparatsHome: HOME,
      });
      const compose = parseCompose(out);
      const paparatsEnv = compose.services['paparats']!['environment'] as Record<string, string>;
      const indexerEnv = compose.services['paparats-indexer']!['environment'] as Record<
        string,
        string
      >;

      expect(paparatsEnv['EMBEDDING_PROVIDER']).toBe('openai');
      expect(paparatsEnv['OPENAI_API_KEY']).toBe('${OPENAI_API_KEY:-}');
      expect(paparatsEnv['EMBED_URL']).toBeUndefined();

      expect(indexerEnv['EMBEDDING_PROVIDER']).toBe('openai');
      expect(indexerEnv['OPENAI_API_KEY']).toBe('${OPENAI_API_KEY:-}');
      expect(indexerEnv['EMBED_URL']).toBeUndefined();
    });

    it('sets EMBEDDING_PROVIDER and VOYAGE_API_KEY for voyage', () => {
      const out = generateCompose({
        embedMode: 'native',
        embeddingProvider: 'voyage',
        paparatsHome: HOME,
      });
      const compose = parseCompose(out);
      const paparatsEnv = compose.services['paparats']!['environment'] as Record<string, string>;

      expect(paparatsEnv['EMBEDDING_PROVIDER']).toBe('voyage');
      expect(paparatsEnv['VOYAGE_API_KEY']).toBe('${VOYAGE_API_KEY:-}');
      expect(paparatsEnv['OPENAI_API_KEY']).toBeUndefined();
      expect(compose.services['embed']).toBeUndefined();
    });

    it('keeps EMBED_URL when embeddingProvider is unset (default = llama)', () => {
      const out = generateCompose({ embedMode: 'native', paparatsHome: HOME });
      const compose = parseCompose(out);
      const env = compose.services['paparats']!['environment'] as Record<string, string>;

      expect(env['EMBEDDING_PROVIDER']).toBeUndefined();
      expect(env['EMBED_URL']).toBe('http://host.docker.internal:18434');
    });

    it('cloud provider still keeps qdrant and bind-mounts intact', () => {
      const out = generateCompose({
        embedMode: 'native',
        embeddingProvider: 'openai',
        paparatsHome: HOME,
        localProjects: [{ name: 'web', hostPath: '/Users/x/web' }],
      });
      const compose = parseCompose(out);

      expect(compose.services['qdrant']).toBeDefined();
      const volumes = compose.services['paparats-indexer']!['volumes'] as string[];
      expect(volumes).toContain('/Users/x/web:/projects/web:ro');
    });
  });
});
