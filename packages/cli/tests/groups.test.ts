import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runGroups, validateStatsResponse, type StatsResponse } from '../src/commands/groups.js';

const mockStats = (res: { status: number; data: unknown }) => ({
  stats: vi.fn().mockResolvedValue(res),
});

function createMockSpinner() {
  return {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  };
}

describe('groups', () => {
  const validData: StatsResponse = {
    groups: { 'my-group': 100, 'other-group': 50 },
    registeredProjects: {
      'my-group': ['project-a', 'project-b'],
      'other-group': ['project-c'],
    },
    usage: {
      searchCount: 10,
      totalTokensSaved: 5000,
      avgTokensSavedPerSearch: 500,
    },
  };

  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
  });

  describe('validateStatsResponse', () => {
    it('returns true for valid response', () => {
      expect(validateStatsResponse(validData)).toBe(true);
    });

    it('returns false for null', () => {
      expect(validateStatsResponse(null)).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(validateStatsResponse('string')).toBe(false);
      expect(validateStatsResponse(123)).toBe(false);
    });

    it('returns false when groups is missing', () => {
      const bad = { ...validData, groups: undefined };
      expect(validateStatsResponse(bad)).toBe(false);
    });

    it('returns false when registeredProjects is missing', () => {
      const bad = { ...validData, registeredProjects: undefined };
      expect(validateStatsResponse(bad)).toBe(false);
    });

    it('returns false when usage is missing', () => {
      const bad = { ...validData, usage: undefined };
      expect(validateStatsResponse(bad)).toBe(false);
    });

    it('returns false when usage.searchCount is not a number', () => {
      const bad = { ...validData, usage: { ...validData.usage, searchCount: 'ten' } };
      expect(validateStatsResponse(bad)).toBe(false);
    });
  });

  describe('runGroups', () => {
    it('outputs JSON when --json', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runGroups(client, { json: true }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(validData, null, 2));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('outputs group names only when --quiet', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runGroups(client, { quiet: true }, { spinner });

      expect(logSpy).toHaveBeenCalledWith('my-group');
      expect(logSpy).toHaveBeenCalledWith('other-group');
    });

    it('sorts by name by default', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runGroups(client, { quiet: true }, { spinner });

      const calls = logSpy.mock.calls.map((c) => c[0]);
      const groupCalls = calls.filter((c) => typeof c === 'string' && !c.includes('index'));
      expect(groupCalls[0]).toBe('my-group');
      expect(groupCalls[1]).toBe('other-group');
    });

    it('sorts by size when --sort size', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runGroups(client, { quiet: true, sort: 'size' }, { spinner });

      const calls = logSpy.mock.calls.map((c) => c[0]);
      const groupCalls = calls.filter((c) => typeof c === 'string' && !c.includes('index'));
      expect(groupCalls[0]).toBe('my-group');
      expect(groupCalls[1]).toBe('other-group');
    });

    it('shows "no groups" message when empty', async () => {
      const client = mockStats({
        status: 200,
        data: { ...validData, groups: {}, registeredProjects: {} },
      });
      const spinner = createMockSpinner();

      await expect(runGroups(client, {}, { spinner })).rejects.toThrow('EXIT:0');

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No groups indexed yet'));
    });

    it('exits 0 without message when empty and --quiet', async () => {
      const client = mockStats({
        status: 200,
        data: { ...validData, groups: {}, registeredProjects: {} },
      });
      const spinner = createMockSpinner();

      await expect(runGroups(client, { quiet: true }, { spinner })).rejects.toThrow('EXIT:0');

      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('No groups indexed yet'));
    });

    it('exits 1 on non-200 status', async () => {
      const client = mockStats({ status: 500, data: {} });
      const spinner = createMockSpinner();

      await expect(runGroups(client, {}, { spinner })).rejects.toThrow('EXIT:1');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch stats'));
    });

    it('outputs JSON error on non-200 when --json', async () => {
      const client = mockStats({ status: 500, data: {} });
      const spinner = createMockSpinner();

      await expect(runGroups(client, { json: true }, { spinner })).rejects.toThrow('EXIT:1');

      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ error: 'Failed to fetch stats from server' })
      );
    });

    it('exits 1 on invalid response shape', async () => {
      const client = mockStats({ status: 200, data: { foo: 'bar' } });
      const spinner = createMockSpinner();

      await expect(runGroups(client, {}, { spinner })).rejects.toThrow('EXIT:1');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid stats response'));
    });

    it('exits 1 and outputs error on network failure', async () => {
      const client = {
        stats: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      const spinner = createMockSpinner();

      await expect(runGroups(client, {}, { spinner })).rejects.toThrow('EXIT:1');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Connection refused'));
    });

    it('outputs JSON error on network failure when --json', async () => {
      const client = {
        stats: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      const spinner = createMockSpinner();

      await expect(runGroups(client, { json: true }, { spinner })).rejects.toThrow('EXIT:1');

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Connection refused' }));
    });

    it('shows verbose stats when --verbose', async () => {
      const dataWithExtra: StatsResponse = {
        ...validData,
        cache: { size: 100, hitCount: 50, maxSize: 1000, hitRate: 0.5 },
        watcher: { 'g/p': { eventsProcessed: 10 } },
        memory: { heapUsed: 100 * 1024 * 1024, heapTotal: 200 * 1024 * 1024 },
      };
      const client = mockStats({ status: 200, data: dataWithExtra });
      const spinner = createMockSpinner();

      await runGroups(client, { verbose: true }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Statistics:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Searches:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cache hit rate:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('File changes processed:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Memory usage:'));
    });

    it('shows basic stats when not verbose and searchCount > 0', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runGroups(client, {}, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('searches'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('tokens saved'));
    });

    it('shows single group details when groupName provided', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runGroups(client, { groupName: 'my-group' }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('my-group'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Chunks:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Projects:'));
    });

    it('outputs single group as JSON when groupName and --json', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runGroups(client, { json: true, groupName: 'my-group' }, { spinner });

      const jsonOutput = logSpy.mock.calls[0]?.[0];
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed).toEqual({
        group: 'my-group',
        chunks: 100,
        projects: ['project-a', 'project-b'],
      });
    });

    it('exits 1 when group not found', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await expect(runGroups(client, { groupName: 'nonexistent' }, { spinner })).rejects.toThrow(
        'EXIT:1'
      );

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Group not found'));
    });

    it('exits 1 when group not found in JSON mode', async () => {
      const client = mockStats({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await expect(
        runGroups(client, { json: true, groupName: 'nonexistent' }, { spinner })
      ).rejects.toThrow('EXIT:1');

      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ error: 'Group not found: nonexistent' })
      );
    });

    it('uses null spinner in JSON mode', async () => {
      const client = mockStats({ status: 200, data: validData });

      await runGroups(client, { json: true }, { spinner: null });

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(validData, null, 2));
    });
  });
});
