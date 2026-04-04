import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { loadIndexerConfig, tryLoadIndexerConfig } from '../src/config-loader.js';

describe('loadIndexerConfig', () => {
  const tmpDir = '/tmp/paparats-test-config';
  const configPath = `${tmpDir}/paparats-indexer.yml`;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(content: string): void {
    fs.writeFileSync(configPath, content);
  }

  it('parses minimal config with single repo', () => {
    writeConfig(`
repos:
  - url: org/repo
`);
    const result = loadIndexerConfig(configPath);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]!.fullName).toBe('org/repo');
    expect(result.repos[0]!.owner).toBe('org');
    expect(result.repos[0]!.name).toBe('repo');
    expect(result.repos[0]!.url).toBe('https://github.com/org/repo.git');
    expect(result.repos[0]!.overrides).toBeUndefined();
  });

  it('parses multiple repos', () => {
    writeConfig(`
repos:
  - url: org/a
  - url: org/b
  - url: other/c
`);
    const result = loadIndexerConfig(configPath);
    expect(result.repos).toHaveLength(3);
    expect(result.repos[0]!.fullName).toBe('org/a');
    expect(result.repos[1]!.fullName).toBe('org/b');
    expect(result.repos[2]!.fullName).toBe('other/c');
  });

  it('includes token in URL when provided', () => {
    writeConfig(`
repos:
  - url: org/repo
`);
    const result = loadIndexerConfig(configPath, 'ghp_abc123');
    expect(result.repos[0]!.url).toBe('https://ghp_abc123@github.com/org/repo.git');
  });

  it('parses per-repo overrides', () => {
    writeConfig(`
repos:
  - url: org/repo
    group: my-group
    language: [typescript, python]
    indexing:
      exclude: [docs, scripts]
      paths: [src/]
      chunkSize: 2048
`);
    const result = loadIndexerConfig(configPath);
    const overrides = result.repos[0]!.overrides;
    expect(overrides).toBeDefined();
    expect(overrides!.group).toBe('my-group');
    expect(overrides!.language).toEqual(['typescript', 'python']);
    expect(overrides!.indexing?.exclude).toEqual(['docs', 'scripts']);
    expect(overrides!.indexing?.paths).toEqual(['src/']);
    expect(overrides!.indexing?.chunkSize).toBe(2048);
  });

  it('parses metadata overrides', () => {
    writeConfig(`
repos:
  - url: org/repo
    metadata:
      service: my-service
      tags: [backend, api]
      git:
        maxCommitsPerFile: 100
`);
    const result = loadIndexerConfig(configPath);
    const overrides = result.repos[0]!.overrides;
    expect(overrides!.metadata?.service).toBe('my-service');
    expect(overrides!.metadata?.tags).toEqual(['backend', 'api']);
    expect(overrides!.metadata?.git?.maxCommitsPerFile).toBe(100);
  });

  it('merges defaults with per-repo overrides', () => {
    writeConfig(`
defaults:
  group: shared-group
  language: typescript
  indexing:
    chunkSize: 2048
    exclude: [node_modules, dist]

repos:
  - url: org/a
  - url: org/b
    group: custom-group
    indexing:
      exclude: [vendor]
`);
    const result = loadIndexerConfig(configPath);

    // Repo A: inherits all defaults
    const a = result.repos[0]!.overrides;
    expect(a).toBeDefined();
    expect(a!.group).toBe('shared-group');
    expect(a!.language).toBe('typescript');
    expect(a!.indexing?.chunkSize).toBe(2048);
    expect(a!.indexing?.exclude).toEqual(['node_modules', 'dist']);

    // Repo B: repo-level overrides win
    const b = result.repos[1]!.overrides;
    expect(b).toBeDefined();
    expect(b!.group).toBe('custom-group');
    expect(b!.language).toBe('typescript'); // inherited from defaults
    expect(b!.indexing?.chunkSize).toBe(2048); // inherited from defaults
    expect(b!.indexing?.exclude).toEqual(['vendor']); // repo wins entirely
  });

  it('parses cron from defaults', () => {
    writeConfig(`
defaults:
  cron: "0 */2 * * *"
repos:
  - url: org/repo
`);
    const result = loadIndexerConfig(configPath);
    expect(result.cron).toBe('0 */2 * * *');
  });

  it('returns undefined cron when not set', () => {
    writeConfig(`
repos:
  - url: org/repo
`);
    const result = loadIndexerConfig(configPath);
    expect(result.cron).toBeUndefined();
  });

  it('throws for missing repos array', () => {
    writeConfig(`
defaults:
  group: test
`);
    expect(() => loadIndexerConfig(configPath)).toThrow(/"repos" must be an array/);
  });

  it('throws for repo entry without url', () => {
    writeConfig(`
repos:
  - group: test
`);
    expect(() => loadIndexerConfig(configPath)).toThrow(/must have a "url" field/);
  });

  it('throws for invalid repo format', () => {
    writeConfig(`
repos:
  - url: just-a-name
`);
    expect(() => loadIndexerConfig(configPath)).toThrow(/Invalid repo format/);
  });

  it('throws for empty YAML', () => {
    writeConfig('');
    expect(() => loadIndexerConfig(configPath)).toThrow(/expected YAML object/);
  });

  it('single language string in overrides', () => {
    writeConfig(`
repos:
  - url: org/repo
    language: ruby
`);
    const result = loadIndexerConfig(configPath);
    expect(result.repos[0]!.overrides!.language).toBe('ruby');
  });
});

describe('tryLoadIndexerConfig', () => {
  const tmpDir = '/tmp/paparats-test-try-config';

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when config file does not exist', () => {
    const result = tryLoadIndexerConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('loads config when file exists', () => {
    fs.writeFileSync(`${tmpDir}/paparats-indexer.yml`, 'repos:\n  - url: org/repo\n');
    const result = tryLoadIndexerConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.repos).toHaveLength(1);
    expect(result!.repos[0]!.fullName).toBe('org/repo');
  });
});
