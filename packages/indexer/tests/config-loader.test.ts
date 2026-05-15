import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { loadIndexerConfig, tryLoadIndexerConfig } from '../src/config-loader.js';

describe('loadIndexerConfig', () => {
  const tmpDir = '/tmp/paparats-test-config';
  const configPath = `${tmpDir}/projects.yml`;

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

  it('throws for repo entry without url or path', () => {
    writeConfig(`
repos:
  - group: test
`);
    expect(() => loadIndexerConfig(configPath)).toThrow(/must have a "url" or "path" field/);
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

  // ── Local-path entries ────────────────────────────────────────────────────

  it('parses local-path entry: derives name from basename and maps localPath to /projects/<name>', () => {
    writeConfig(`
repos:
  - path: /Users/alice/code/billing
`);
    const result = loadIndexerConfig(configPath);
    expect(result.repos).toHaveLength(1);
    const r = result.repos[0]!;
    expect(r.name).toBe('billing');
    expect(r.fullName).toBe('billing');
    expect(r.owner).toBe('_local');
    expect(r.url).toBe('');
    expect(r.localPath).toBe('/projects/billing');
  });

  it('parses local-path entry with explicit name override', () => {
    writeConfig(`
repos:
  - path: /Users/alice/code/billing
    name: billing-v2
`);
    const result = loadIndexerConfig(configPath);
    const r = result.repos[0]!;
    expect(r.name).toBe('billing-v2');
    expect(r.fullName).toBe('billing-v2');
    expect(r.localPath).toBe('/projects/billing-v2');
  });

  it('rejects entry with both url and path', () => {
    writeConfig(`
repos:
  - url: org/repo
    path: /Users/alice/code/billing
`);
    expect(() => loadIndexerConfig(configPath)).toThrow(/cannot set both "url" and "path"/);
  });

  it('rejects local-path entry with relative path', () => {
    writeConfig(`
repos:
  - path: relative/path
`);
    expect(() => loadIndexerConfig(configPath)).toThrow(/must be absolute/);
  });

  it('rejects duplicate project names within the file', () => {
    writeConfig(`
repos:
  - path: /Users/alice/code/billing
  - path: /Users/bob/code/billing
`);
    expect(() => loadIndexerConfig(configPath)).toThrow(/Duplicate project name "billing"/);
  });

  it('rejects duplicate when one entry overrides name to clash with another basename', () => {
    writeConfig(`
repos:
  - path: /Users/alice/code/billing
  - path: /Users/alice/code/legacy
    name: billing
`);
    expect(() => loadIndexerConfig(configPath)).toThrow(/Duplicate project name "billing"/);
  });

  it('parses mixed file with local-path and remote entries', () => {
    writeConfig(`
repos:
  - path: /Users/alice/code/billing
    group: dev
  - url: org/repo
    group: prod
`);
    const result = loadIndexerConfig(configPath);
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0]!.name).toBe('billing');
    expect(result.repos[0]!.localPath).toBe('/projects/billing');
    expect(result.repos[0]!.overrides?.group).toBe('dev');
    expect(result.repos[1]!.fullName).toBe('org/repo');
    expect(result.repos[1]!.localPath).toBeUndefined();
    expect(result.repos[1]!.overrides?.group).toBe('prod');
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
    fs.writeFileSync(`${tmpDir}/projects.yml`, 'repos:\n  - url: org/repo\n');
    const result = tryLoadIndexerConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.repos).toHaveLength(1);
    expect(result!.repos[0]!.fullName).toBe('org/repo');
  });

  it('falls back to paparats-indexer.yml when projects.yml is absent', () => {
    fs.writeFileSync(`${tmpDir}/paparats-indexer.yml`, 'repos:\n  - url: legacy/repo\n');
    const result = tryLoadIndexerConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.repos).toHaveLength(1);
    expect(result!.repos[0]!.fullName).toBe('legacy/repo');
  });

  it('prefers projects.yml when both files exist', () => {
    fs.writeFileSync(`${tmpDir}/projects.yml`, 'repos:\n  - url: new/repo\n');
    fs.writeFileSync(`${tmpDir}/paparats-indexer.yml`, 'repos:\n  - url: legacy/repo\n');
    const result = tryLoadIndexerConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.repos).toHaveLength(1);
    expect(result!.repos[0]!.fullName).toBe('new/repo');
  });
});
