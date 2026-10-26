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
 * Entries already set through `GIT_CONFIG_COUNT` are kept. Returns an empty
 * object without a token.
 */
export function gitAuthEnv(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (!token) return {};
  const count = Number.parseInt(env['GIT_CONFIG_COUNT'] ?? '0', 10);
  const i = Number.isInteger(count) && count > 0 ? count : 0;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: String(i + 1),
    [`GIT_CONFIG_KEY_${i}`]: `http.${GITHUB_PREFIX}.extraHeader`,
    [`GIT_CONFIG_VALUE_${i}`]: `Authorization: Basic ${basic}`,
    // Fail instead of waiting for a username nobody will type.
    GIT_TERMINAL_PROMPT: '0',
  };
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
