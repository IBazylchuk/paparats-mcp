import { describe, it, expect } from 'vitest';
import { TriggerQueue } from '../src/trigger-queue.js';
import { KeyedSerializer } from '../src/keyed-serializer.js';
import type { RepoConfig } from '../src/types.js';

const repo = (fullName: string): RepoConfig => {
  const name = fullName.split('/').pop()!;
  return { url: '', owner: 'org', name, fullName };
};

describe('TriggerQueue', () => {
  it('is empty until something is added', () => {
    const q = new TriggerQueue();
    expect(q.hasPending).toBe(false);
    expect(q.take()).toBeNull();
  });

  it('treats an empty repo list as "all"', () => {
    const q = new TriggerQueue();
    q.add({ repos: [] });
    const cycle = q.take()!;
    expect(cycle.filter).toBeUndefined();
    expect(cycle.isForced(repo('org/a'))).toBe(false);
  });

  it('unions repo sets and keeps force per repo', () => {
    const q = new TriggerQueue();
    q.add({ repos: ['a'], force: true });
    q.add({ repos: ['org/b'] });
    const cycle = q.take()!;
    expect(cycle.filter).toEqual(['a', 'org/b']);
    expect(cycle.isForced(repo('org/a'))).toBe(true);
    expect(cycle.isForced(repo('org/b'))).toBe(false);
  });

  it('widens to all when any request is unfiltered, without losing force', () => {
    const q = new TriggerQueue();
    q.add({ repos: ['a'], force: true });
    q.add({});
    const cycle = q.take()!;
    expect(cycle.filter).toBeUndefined();
    expect(cycle.isForced(repo('org/a'))).toBe(true);
    expect(cycle.isForced(repo('org/c'))).toBe(false);
  });

  it('forces everything for an unfiltered force request', () => {
    const q = new TriggerQueue();
    q.add({ force: true });
    expect(q.take()!.isForced(repo('org/z'))).toBe(true);
  });

  it('empties on take', () => {
    const q = new TriggerQueue();
    q.add({ repos: ['a'], force: true });
    q.take();
    expect(q.hasPending).toBe(false);
    q.add({ repos: ['b'] });
    const cycle = q.take()!;
    expect(cycle.filter).toEqual(['b']);
    expect(cycle.isForced(repo('org/a'))).toBe(false);
  });
});

describe('KeyedSerializer', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('runs tasks for one key strictly one after another', async () => {
    const s = new KeyedSerializer();
    const events: string[] = [];
    const gate = deferred();
    const first = s.run('api', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = s.run('api', async () => {
      events.push('second:start');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('runs different keys concurrently', async () => {
    const s = new KeyedSerializer();
    const gate = deferred();
    const events: string[] = [];
    const a = s.run('a', async () => {
      await gate.promise;
      events.push('a');
    });
    await s.run('b', async () => {
      events.push('b');
    });
    expect(events).toEqual(['b']);
    gate.resolve();
    await a;
    expect(events).toEqual(['b', 'a']);
  });

  it('keeps going after a failed task and reports its error to the caller', async () => {
    const s = new KeyedSerializer();
    const failed = s.run('api', async () => {
      throw new Error('boom');
    });
    const next = s.run('api', async () => 42);
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe(42);
  });
});
