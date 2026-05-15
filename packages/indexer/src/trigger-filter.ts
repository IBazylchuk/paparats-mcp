import type { RepoConfig } from './types.js';

/**
 * Resolve a `/trigger` filter (list of repo identifiers from the request
 * body) to actual `RepoConfig` entries from the configured repo list.
 *
 * Accepts both short names (`my-repo`) and full names (`org/my-repo`)
 * because callers like `paparats add` send short names from the CLI, but
 * indexer YAML entries for remote repos canonicalize to `owner/repo` in
 * `fullName`. Without dual-key matching, remote-repo triggers would
 * silently match nothing — the CLI's `--force` recovery path depends on
 * this signal being honest.
 */
export function resolveTriggerTargets(repos: RepoConfig[], filter: string[]): RepoConfig[] {
  const wanted = new Set(filter);
  return repos.filter((r) => wanted.has(r.fullName) || wanted.has(r.name));
}
