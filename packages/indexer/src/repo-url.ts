/** A remote repository as the indexer clones it. */
export interface RemoteRepo {
  /** Clone URL, never with credentials in it. */
  url: string;
  /** Folder under the clone directory the repo goes into (`owner`, or `host/group/...`). */
  owner: string;
  /** Repository name: the project name unless overridden. */
  name: string;
  /** `owner/repo` on GitHub, `host/group/.../repo` elsewhere; what `/trigger` matches. */
  fullName: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

function segments(raw: string, spec: string): string[] {
  const parts = raw
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || !NAME_RE.test(p))) {
    throw new Error(`Invalid repository path in "${spec}".`);
  }
  return parts;
}

/**
 * Read a repository entry: `owner/repo` (GitHub), or an `https://` (or `http://`)
 * URL of any host — GitHub, GitHub Enterprise, GitLab with subgroups, Gitea. SSH
 * addresses are refused, as the indexer image has no SSH client; a token for a
 * private repository goes in `GITHUB_TOKEN` or `GIT_TOKENS`, never in the URL.
 */
export function parseRepoSpec(spec: string): RemoteRepo {
  const input = spec.trim();
  if (/^(git@|ssh:\/\/)/.test(input)) {
    throw new Error(
      `SSH addresses are not supported ("${input}"): use the https:// URL, with a token in ` +
        'GITHUB_TOKEN or GIT_TOKENS for a private repository.'
    );
  }
  if (!/^https?:\/\//.test(input)) {
    const parts = input.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid repo format: "${input}". Expected "owner/repo" or an https:// URL.`);
    }
    const [owner, name] = segments(input, input) as [string, string];
    return {
      url: `https://github.com/${owner}/${name}.git`,
      owner,
      name,
      fullName: `${owner}/${name}`,
    };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid repository URL: "${input}".`);
  }
  if (url.username || url.password) {
    throw new Error(
      `The URL of "${url.hostname}${url.pathname}" carries credentials: put the token in ` +
        'GITHUB_TOKEN or GIT_TOKENS instead.'
    );
  }
  if (url.search || url.hash) throw new Error(`Invalid repository URL: "${input}".`);
  const parts = segments(url.pathname, input);
  if (parts.length < 2) {
    throw new Error(`Expected a repository path such as /group/repo in "${input}".`);
  }
  const name = parts[parts.length - 1]!;
  const host = url.hostname.toLowerCase();
  if (GITHUB_HOSTS.has(host) && !url.port) {
    if (parts.length !== 2) throw new Error(`Expected github.com/owner/repo, got "${input}".`);
    const owner = parts[0]!;
    return {
      url: `https://github.com/${owner}/${name}.git`,
      owner,
      name,
      fullName: `${owner}/${name}`,
    };
  }
  const where = url.host.toLowerCase();
  const repoPath = parts.join('/');
  return {
    url: `${url.protocol}//${where}/${repoPath}.git`,
    owner: [where.replace(':', '_'), ...parts.slice(0, -1)].join('/'),
    name,
    fullName: `${where}/${repoPath}`,
  };
}
