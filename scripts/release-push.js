#!/usr/bin/env node
/**
 * Creates tag v{VERSION} from current root package.json and pushes branch + tag.
 * Run after yarn release and yarn publish:npm so the MCP registry finds the package on npm.
 * Triggers .github/workflows/docker-publish.yml and publish-mcp.yml.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

let tagExisted = false;
try {
  execSync(`git tag ${tag}`, { encoding: 'utf8', cwd: rootDir });
} catch (err) {
  const output = (err?.stderr ?? err?.message ?? '') || '';
  if (output.includes('already exists')) {
    tagExisted = true;
    console.log(`Tag ${tag} already exists, pushing...`);
  } else {
    throw err;
  }
}
if (!tagExisted) {
  console.log(`Tagging ${tag} and pushing (triggers Docker + MCP workflows)...`);
}

execSync('git push origin HEAD', { stdio: 'inherit', cwd: rootDir });
execSync(`git push origin ${tag}`, { stdio: 'inherit', cwd: rootDir });
