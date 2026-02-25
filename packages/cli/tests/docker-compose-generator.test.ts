import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { generateDockerCompose, generateServerCompose } from '../src/docker-compose-generator.js';

interface ComposeFile {
  services: Record<string, Record<string, unknown>>;
  volumes: Record<string, unknown>;
  networks: Record<string, unknown>;
}

function parseCompose(output: string): ComposeFile {
  return yaml.load(output) as ComposeFile;
}

describe('generateDockerCompose', () => {
  it('generates local mode with qdrant + paparats only', () => {
    const output = generateDockerCompose({ ollamaMode: 'local' });
    const compose = parseCompose(output);

    expect(compose.services['qdrant']).toBeDefined();
    expect(compose.services['paparats']).toBeDefined();
    expect(compose.services['ollama']).toBeUndefined();

    // Ollama URL points to host
    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['OLLAMA_URL']).toContain('host.docker.internal');
  });

  it('generates docker mode with qdrant + paparats + ollama', () => {
    const output = generateDockerCompose({ ollamaMode: 'docker' });
    const compose = parseCompose(output);

    expect(compose.services['qdrant']).toBeDefined();
    expect(compose.services['paparats']).toBeDefined();
    expect(compose.services['ollama']).toBeDefined();

    // Ollama URL points to internal service
    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['OLLAMA_URL']).toBe('http://ollama:11434');

    // paparats depends on ollama
    const deps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
    expect(deps['ollama']).toBeDefined();

    // ollama_data volume exists
    expect(compose.volumes['ollama_data']).toBeDefined();
  });

  it('uses custom ports', () => {
    const output = generateDockerCompose({
      ollamaMode: 'docker',
      ports: { qdrant: 7333, paparats: 8876, ollama: 12434 },
    });
    const compose = parseCompose(output);

    const qdrantPorts = compose.services['qdrant']!['ports'] as string[];
    expect(qdrantPorts[0]).toContain('7333');

    const paparatsPorts = compose.services['paparats']!['ports'] as string[];
    expect(paparatsPorts[0]).toContain('8876');

    const ollamaPorts = compose.services['ollama']!['ports'] as string[];
    expect(ollamaPorts[0]).toContain('12434');
  });

  it('uses ibaz/paparats-ollama image', () => {
    const output = generateDockerCompose({ ollamaMode: 'docker' });
    const compose = parseCompose(output);
    expect(compose.services['ollama']!['image']).toBe('ibaz/paparats-ollama:latest');
  });

  it('output is valid YAML with header comment', () => {
    const output = generateDockerCompose({ ollamaMode: 'local' });
    expect(output).toContain('# paparats-mcp');
    // Should parse without errors
    const compose = parseCompose(output);
    expect(compose.services).toBeDefined();
  });

  it('omits qdrant service when qdrantUrl is set', () => {
    const output = generateDockerCompose({
      ollamaMode: 'local',
      qdrantUrl: 'http://my-qdrant:6333',
    });
    const compose = parseCompose(output);

    expect(compose.services['qdrant']).toBeUndefined();
    expect(compose.services['paparats']).toBeDefined();
    expect(compose.volumes['qdrant_data']).toBeUndefined();

    const env = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(env['QDRANT_URL']).toBe('http://my-qdrant:6333');

    const deps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
    expect(deps['qdrant']).toBeUndefined();
  });

  it('still includes ollama when qdrantUrl is set with docker ollama', () => {
    const output = generateDockerCompose({
      ollamaMode: 'docker',
      qdrantUrl: 'http://my-qdrant:6333',
    });
    const compose = parseCompose(output);

    expect(compose.services['qdrant']).toBeUndefined();
    expect(compose.services['ollama']).toBeDefined();
    expect(compose.services['paparats']).toBeDefined();

    const deps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
    expect(deps['qdrant']).toBeUndefined();
    expect(deps['ollama']).toBeDefined();
  });
});

describe('generateServerCompose', () => {
  it('generates all four services', () => {
    const output = generateServerCompose({ ollamaMode: 'docker' });
    const compose = parseCompose(output);

    expect(compose.services['qdrant']).toBeDefined();
    expect(compose.services['ollama']).toBeDefined();
    expect(compose.services['paparats']).toBeDefined();
    expect(compose.services['paparats-indexer']).toBeDefined();
  });

  it('indexer depends on qdrant and ollama', () => {
    const output = generateServerCompose({ ollamaMode: 'docker' });
    const compose = parseCompose(output);

    const deps = compose.services['paparats-indexer']!['depends_on'] as Record<string, unknown>;
    expect(deps['qdrant']).toBeDefined();
    expect(deps['ollama']).toBeDefined();
  });

  it('includes indexer_repos volume', () => {
    const output = generateServerCompose({ ollamaMode: 'docker' });
    const compose = parseCompose(output);

    expect(compose.volumes['indexer_repos']).toBeDefined();
  });

  it('indexer uses ibaz/paparats-indexer image', () => {
    const output = generateServerCompose({ ollamaMode: 'docker' });
    const compose = parseCompose(output);

    expect(compose.services['paparats-indexer']!['image']).toBe('ibaz/paparats-indexer:latest');
  });

  it('uses custom cron in indexer environment', () => {
    const output = generateServerCompose({
      ollamaMode: 'docker',
      cron: '0 */2 * * *',
    });
    const compose = parseCompose(output);

    const env = compose.services['paparats-indexer']!['environment'] as Record<string, string>;
    expect(env['CRON']).toContain('0 */2 * * *');
  });

  it('paparats depends on both qdrant and ollama', () => {
    const output = generateServerCompose({ ollamaMode: 'docker' });
    const compose = parseCompose(output);

    const deps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
    expect(deps['qdrant']).toBeDefined();
    expect(deps['ollama']).toBeDefined();
  });

  it('omits qdrant service when qdrantUrl is set', () => {
    const output = generateServerCompose({
      ollamaMode: 'docker',
      qdrantUrl: 'http://external-qdrant:6333',
    });
    const compose = parseCompose(output);

    expect(compose.services['qdrant']).toBeUndefined();
    expect(compose.services['ollama']).toBeDefined();
    expect(compose.services['paparats']).toBeDefined();
    expect(compose.services['paparats-indexer']).toBeDefined();
    expect(compose.volumes['qdrant_data']).toBeUndefined();

    // paparats uses external URL and depends only on ollama
    const paparatsEnv = compose.services['paparats']!['environment'] as Record<string, string>;
    expect(paparatsEnv['QDRANT_URL']).toBe('http://external-qdrant:6333');
    const paparatsDeps = compose.services['paparats']!['depends_on'] as Record<string, unknown>;
    expect(paparatsDeps['qdrant']).toBeUndefined();
    expect(paparatsDeps['ollama']).toBeDefined();

    // indexer uses external URL and depends only on ollama
    const indexerEnv = compose.services['paparats-indexer']!['environment'] as Record<
      string,
      string
    >;
    expect(indexerEnv['QDRANT_URL']).toBe('http://external-qdrant:6333');
    const indexerDeps = compose.services['paparats-indexer']!['depends_on'] as Record<
      string,
      unknown
    >;
    expect(indexerDeps['qdrant']).toBeUndefined();
    expect(indexerDeps['ollama']).toBeDefined();
  });
});
