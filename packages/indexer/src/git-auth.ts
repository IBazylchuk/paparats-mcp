import { simpleGit, type SimpleGit } from 'simple-git';

/** Only requests to this prefix get the header, so a redirect elsewhere never carries the token. */
const GITHUB_PREFIX = 'https://github.com/';

/**
 * Environment that makes every git process send the GitHub token as an
 * `Authorization` header (`http.<url>.extraHeader`, set through `GIT_CONFIG_*`)
 * instead of the token sitting in the clone URL. With the token in the URL,
 * libcurl 8.23 sends it on the first request of a fetch but not the next
 * one, so git gets a 401 on private repositories.
 *
 * `hostTokens` (from `GIT_TOKENS`) do the same for other hosts — GitHub
 * Enterprise, GitLab, Gitea — each scoped to `https://<host>/`; all of them take
 * a token as the basic-auth password.
 *
 * Entries already set through `GIT_CONFIG_COUNT` are kept. Returns an empty
 * object without a token.
 */
export function gitAuthEnv(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  hostTokens: Record<string, string> = {}
): Record<string, string> {
  const prefixes: Array<[string, string]> = [];
  if (token) prefixes.push([GITHUB_PREFIX, token]);
  for (const [host, hostToken] of Object.entries(hostTokens)) {
    prefixes.push([`https://${host}/`, hostToken]);
  }
  if (prefixes.length === 0) return {};
  const count = Number.parseInt(env['GIT_CONFIG_COUNT'] ?? '0', 10);
  const first = Number.isInteger(count) && count > 0 ? count : 0;
  const out: Record<string, string> = {};
  prefixes.forEach(([prefix, secret], n) => {
    const basic = Buffer.from(`x-access-token:${secret}`).toString('base64');
    out[`GIT_CONFIG_KEY_${first + n}`] = `http.${prefix}.extraHeader`;
    out[`GIT_CONFIG_VALUE_${first + n}`] = `Authorization: Basic ${basic}`;
  });
  out['GIT_CONFIG_COUNT'] = String(first + prefixes.length);
  // Fail instead of waiting for a username nobody will type.
  out['GIT_TERMINAL_PROMPT'] = '0';
  return out;
}

/**
 * Read `GIT_TOKENS`: `host=token` pairs separated by commas
 * (`gitlab.example.com=glpat-...,ghe.example.com=ghp_...`). A host may carry a
 * port. Throws on a malformed pair, naming its position, never the token.
 */
export function parseGitTokens(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || !raw.trim()) return out;
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .forEach((pair, i) => {
      const eq = pair.indexOf('=');
      const host = eq > 0 ? pair.slice(0, eq).trim().toLowerCase() : '';
      const token = eq > 0 ? pair.slice(eq + 1).trim() : '';
      if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || !token || /\s/.test(token)) {
        throw new Error(
          `GIT_TOKENS: entry #${i + 1} is not "host=token" (e.g. gitlab.example.com=<token>).`
        );
      }
      out[host] = token;
    });
  return out;
}

/** Variables `gitAuthEnv` sets, plus config entries set through the environment before it. */
const AUTH_ENV = /^(GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)|GIT_TERMINAL_PROMPT)$/;

/**
 * simple-git for the indexer's git calls. simple-git drops every `GIT_*`
 * variable from the environment it passes to git unless allowed by name, which
 * would drop the header `gitAuthEnv` sets, so the config entries are allowed.
 */
export function createGit(baseDir?: string): SimpleGit {
  const allowEnvironment = Object.keys(process.env).filter((key) => AUTH_ENV.test(key));
  return simpleGit({ ...(baseDir !== undefined ? { baseDir } : {}), allowEnvironment });
}
