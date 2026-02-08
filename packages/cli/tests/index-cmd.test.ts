import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runIndex,
  validateIndexResponse,
  printDryRun,
  type IndexResponse,
} from '../src/commands/index-cmd.js';
const validData: IndexResponse = {
  group: 'my-group',
  project: 'my-project',
  chunks: 42,
};

const defaultConfig = {
  config: {
    group: 'my-group',
    language: 'typescript' as const,
    indexing: { paths: ['./'] },
  },
  projectDir: '',
};

function createMockIndexClient(res: { status: number; data: unknown }) {
  return {
    health: vi.fn().mockResolvedValue({ status: 200 }),
    indexContent: vi.fn().mockResolvedValue(res),
  };
}

function createMockSpinner() {
  return {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  };
}

describe('index-cmd', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `paparats-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'foo.ts'), 'const x = 1;');

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('validateIndexResponse', () => {
    it('returns true for valid response', () => {
      expect(validateIndexResponse(validData)).toBe(true);
    });

    it('returns true for response with optional fields', () => {
      expect(validateIndexResponse({ ...validData, skipped: 5, errors: ['err1'] })).toBe(true);
    });

    it('returns false for null', () => {
      expect(validateIndexResponse(null)).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(validateIndexResponse('string')).toBe(false);
      expect(validateIndexResponse(123)).toBe(false);
    });

    it('returns false when group is missing', () => {
      const bad = { ...validData, group: undefined };
      expect(validateIndexResponse(bad)).toBe(false);
    });

    it('returns false when project is missing', () => {
      const bad = { ...validData, project: undefined };
      expect(validateIndexResponse(bad)).toBe(false);
    });

    it('returns false when chunks is missing', () => {
      const bad = { ...validData, chunks: undefined };
      expect(validateIndexResponse(bad)).toBe(false);
    });

    it('returns false when chunks is not a number', () => {
      const bad = { ...validData, chunks: '42' };
      expect(validateIndexResponse(bad)).toBe(false);
    });
  });

  describe('printDryRun', () => {
    it('prints config summary', () => {
      const config = {
        config: {
          group: 'g',
          language: 'typescript',
          indexing: { paths: ['src'], exclude: ['node_modules'] },
        },
        projectDir: '/tmp/proj',
      };
      printDryRun(config);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Dry run mode'));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Group:') && expect.stringContaining('g')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Project:') && expect.stringContaining('/tmp/proj')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Language:') && expect.stringContaining('typescript')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Paths:') && expect.stringContaining('src')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Exclude:') && expect.stringContaining('node_modules')
      );
    });

    it('handles array language', () => {
      const config = {
        config: { group: 'g', language: ['ruby', 'typescript'] },
        projectDir: '/tmp/proj',
      };
      printDryRun(config);
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Language:.*ruby.*typescript/));
    });
  });

  describe('runIndex', () => {
    it('outputs success message on successful index', async () => {
      const client = createMockIndexClient({ status: 200, data: validData });
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };
      const projectName = path.basename(tmpDir);

      await runIndex(client, tmpDir, 'my-group', config, {}, { spinner });

      expect(spinner.succeed).toHaveBeenCalledWith(expect.stringContaining(projectName));
      expect(spinner.succeed).toHaveBeenCalledWith(expect.stringContaining('my-group'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\d+ chunks indexed/));
    });

    it('outputs JSON when --json', async () => {
      const client = createMockIndexClient({ status: 200, data: validData });
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };
      const projectName = path.basename(tmpDir);

      await runIndex(client, tmpDir, 'my-group', config, { json: true }, { spinner });

      expect(logSpy).toHaveBeenCalled();
      const jsonOutput = logSpy.mock.calls[0]?.[0];
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed.group).toBe('my-group');
      expect(parsed.project).toBe(projectName);
      expect(parsed.chunks).toBeDefined();
      expect(parsed.elapsed).toBeDefined();
      expect(parsed.timestamp).toBeDefined();
    });

    it('calls indexContent with timeout and force when provided', async () => {
      const client = createMockIndexClient({ status: 200, data: validData });
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };

      await runIndex(client, tmpDir, 'g', config, { timeout: 120_000, force: true }, { spinner });

      expect(client.indexContent).toHaveBeenCalledWith(
        'g',
        path.basename(tmpDir),
        expect.any(Array),
        expect.objectContaining({
          config: expect.any(Object),
          force: true,
          timeout: 120_000,
        })
      );
    });

    it('exits 1 on non-200 status', async () => {
      const client = createMockIndexClient({
        status: 500,
        data: { error: 'Server error' },
      });
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };

      await expect(runIndex(client, tmpDir, 'g', config, {}, { spinner })).rejects.toThrow(
        'EXIT:1'
      );

      expect(spinner.fail).toHaveBeenCalledWith(expect.stringContaining('Indexing failed'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Server error'));
    });

    it('exits 1 on invalid response shape', async () => {
      const client = createMockIndexClient({
        status: 200,
        data: { chunks: 'not-a-number' }, // causes validation to fail
      });
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };

      await expect(runIndex(client, tmpDir, 'g', config, {}, { spinner })).rejects.toThrow(
        'EXIT:1'
      );

      expect(spinner.fail).toHaveBeenCalledWith(expect.stringContaining('Invalid response'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Expected:'));
    });

    it('outputs JSON error on failure when --json', async () => {
      const client = createMockIndexClient({
        status: 500,
        data: { error: 'Server error' },
      });
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };

      await expect(
        runIndex(client, tmpDir, 'g', config, { json: true }, { spinner })
      ).rejects.toThrow('EXIT:1');

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Server error' }));
    });

    it('exits 1 on network failure', async () => {
      const client = {
        health: vi.fn().mockResolvedValue({ status: 200 }),
        indexContent: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };

      await expect(runIndex(client, tmpDir, 'g', config, {}, { spinner })).rejects.toThrow(
        'EXIT:1'
      );

      expect(spinner.fail).toHaveBeenCalledWith('Indexing failed');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Connection refused'));
    });

    it('exits 130 on abort', async () => {
      const client = {
        health: vi.fn().mockResolvedValue({ status: 200 }),
        indexContent: vi.fn().mockRejectedValue(new Error('Request aborted')),
      };
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };

      await expect(runIndex(client, tmpDir, 'g', config, {}, { spinner })).rejects.toThrow(
        'EXIT:130'
      );

      expect(spinner.fail).toHaveBeenCalledWith('Indexing cancelled');
    });

    it('shows verbose output when skipped and errors present', async () => {
      const dataWithExtra: IndexResponse = {
        ...validData,
        skipped: 3,
        errors: ['file1.ts: parse error'],
      };
      const client = createMockIndexClient({ status: 200, data: dataWithExtra });
      const spinner = createMockSpinner();
      const config = { ...defaultConfig, projectDir: tmpDir };

      await runIndex(client, tmpDir, 'g', config, { verbose: true }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/3 files skipped/));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/1 errors encountered/));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/file1.ts: parse error/));
    });

    it('uses null spinner in JSON mode', async () => {
      const client = createMockIndexClient({ status: 200, data: validData });
      const config = { ...defaultConfig, projectDir: tmpDir };

      await runIndex(client, tmpDir, 'g', config, { json: true }, { spinner: null });

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/"group":\s*"g"/));
    });
  });
});
