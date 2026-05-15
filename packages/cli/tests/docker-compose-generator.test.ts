import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
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
  it('emits qdrant + paparats + indexer for ollamaMode=native (no docker ollama)', () => {
    const out = generateCompose({ ollamaMode: 'native', paparatsHome: HOME });
    const compose = parseCompose(out);

    expect(compose.services['qdrant']).toBeDefined();
    expect(compose.services['paparats']).toBeDefined();
    expect(compose.services['paparats-indexer']).toBeDefined();
    expect(compose.services['ollama']).toBeUndefined();

    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['OLLAMA_URL']).toBe('http://host.docker.internal:11434');
  });

  it('emits ollama service for ollamaMode=docker and wires depends_on', () => {
    const out = generateCompose({ ollamaMode: 'docker', paparatsHome: HOME });
    const compose = parseCompose(out);

    expect(compose.services['ollama']).toBeDefined();
    const paparatsDeps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
    const indexerDeps = compose.services['paparats-indexer']!['depends_on'] as Record<
      string,
      unknown
    >;
    expect(paparatsDeps['ollama']).toBeDefined();
    expect(indexerDeps['ollama']).toBeDefined();
    expect(compose.volumes['ollama_data']).toBeDefined();
  });

  it('uses provided OLLAMA_URL for ollamaMode=external', () => {
    const out = generateCompose({
      ollamaMode: 'external',
      ollamaUrl: 'http://10.0.0.5:11434',
      paparatsHome: HOME,
    });
    const compose = parseCompose(out);

    expect(compose.services['ollama']).toBeUndefined();
    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['OLLAMA_URL']).toBe('http://10.0.0.5:11434');
  });

  it('throws when ollamaMode=external and ollamaUrl missing', () => {
    expect(() => generateCompose({ ollamaMode: 'external', paparatsHome: HOME })).toThrow(
      /ollamaUrl/
    );
  });

  it('omits qdrant service when qdrantUrl is set', () => {
    const out = generateCompose({
      ollamaMode: 'native',
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
      ollamaMode: 'native',
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
    const out = generateCompose({ ollamaMode: 'native', paparatsHome: HOME });
    const compose = parseCompose(out);
    const volumes = compose.services['paparats-indexer']!['volumes'] as string[];
    expect(volumes).toContain(`${HOME}:/config:ro`);
  });

  it('adds bind-mount per local project', () => {
    const out = generateCompose({
      ollamaMode: 'native',
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
      ollamaMode: 'native',
      paparatsHome: HOME,
      localProjects: [],
    });
    const compose = parseCompose(out);
    const volumes = compose.services['paparats-indexer']!['volumes'] as string[];
    const projectMounts = volumes.filter((v) => v.includes('/projects/'));
    expect(projectMounts).toEqual([]);
  });

  it('output is valid YAML with header comment', () => {
    const out = generateCompose({ ollamaMode: 'native', paparatsHome: HOME });
    expect(out).toContain('# paparats-mcp');
    const compose = parseCompose(out);
    expect(compose.services).toBeDefined();
    expect(compose.services['paparats-indexer']).toBeDefined();
  });

  it('honors port overrides', () => {
    const out = generateCompose({
      ollamaMode: 'docker',
      paparatsHome: HOME,
      ports: { qdrant: 7333, paparats: 8876, ollama: 12434, indexer: 9999 },
    });
    const compose = parseCompose(out);
    expect((compose.services['qdrant']!['ports'] as string[])[0]).toContain('7333');
    expect((compose.services['paparats']!['ports'] as string[])[0]).toContain('8876');
    expect((compose.services['ollama']!['ports'] as string[])[0]).toContain('12434');
    expect((compose.services['paparats-indexer']!['ports'] as string[])[0]).toContain('9999');
  });

  it('default cron set when not provided', () => {
    const out = generateCompose({ ollamaMode: 'native', paparatsHome: HOME });
    const compose = parseCompose(out);
    const env = compose.services['paparats-indexer']!['environment'] as Record<string, string>;
    expect(env['CRON']).toContain('0 */6 * * *');
  });

  it('custom cron override', () => {
    const out = generateCompose({ ollamaMode: 'native', paparatsHome: HOME, cron: '*/15 * * * *' });
    const compose = parseCompose(out);
    const env = compose.services['paparats-indexer']!['environment'] as Record<string, string>;
    expect(env['CRON']).toContain('*/15 * * * *');
  });
});
