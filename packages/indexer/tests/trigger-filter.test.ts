import { describe, it, expect } from 'vitest';
import { resolveTriggerTargets } from '../src/trigger-filter.js';
import type { RepoConfig } from '../src/types.js';

const remote: RepoConfig = {
  url: 'https://github.com/acme/widgets.git',
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
};

const local: RepoConfig = {
  url: '',
  owner: '_local',
  name: 'my-app',
  fullName: 'my-app',
  localPath: '/projects/my-app',
};

const otherRemote: RepoConfig = {
  url: 'https://github.com/other/widgets.git',
  owner: 'other',
  name: 'widgets',
  fullName: 'other/widgets',
};

describe('resolveTriggerTargets', () => {
  it('matches a remote repo by short name (CLI sends short names)', () => {
    const out = resolveTriggerTargets([remote, local], ['widgets']);
    expect(out).toEqual([remote]);
  });

  it('matches a remote repo by fullName', () => {
    const out = resolveTriggerTargets([remote, local], ['acme/widgets']);
    expect(out).toEqual([remote]);
  });

  it('matches a local repo by name (name === fullName)', () => {
    const out = resolveTriggerTargets([remote, local], ['my-app']);
    expect(out).toEqual([local]);
  });

  it('returns empty when no identifier matches — caller is expected to 404', () => {
    const out = resolveTriggerTargets([remote, local], ['unknown']);
    expect(out).toEqual([]);
  });

  it('matches mixed identifiers in a single call (some by name, some by fullName)', () => {
    const out = resolveTriggerTargets([remote, local, otherRemote], ['my-app', 'other/widgets']);
    expect(out).toEqual([local, otherRemote]);
  });

  it('does not deduplicate when both name and fullName for the same repo are listed', () => {
    // The name-or-fullName lookup hits the same repo twice in the wanted set,
    // but filter() iterates repos once, so the result still has length 1.
    const out = resolveTriggerTargets([remote], ['widgets', 'acme/widgets']);
    expect(out).toEqual([remote]);
  });

  it('disambiguates two repos that share a short name — both match by name', () => {
    // When two remote repos collapse to the same short name, sending the short
    // name matches both. Callers (CLI) should prefer fullName for remotes to
    // avoid this; the resolver itself is honest about the ambiguity.
    const out = resolveTriggerTargets([remote, otherRemote], ['widgets']);
    expect(out).toEqual([remote, otherRemote]);
  });
});
