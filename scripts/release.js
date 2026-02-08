#!/usr/bin/env node
/**
 * Creates git tag v{VERSION} and pushes to origin.
 * Triggers .github/workflows/docker-publish.yml
 *
 * Usage: yarn release [version]
 *   yarn release       → uses version from package.json
 *   yarn release 1.0.0 → tags v1.0.0
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const version = process.argv[2] ?? pkg.version;
if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/.test(version)) {
  console.error('Invalid version format (expected semver, e.g. 1.0.0 or 1.0.0-alpha.1)');
  process.exit(1);
}
const tag = `v${version}`;

let tagExisted = false;
try {
  execSync(`git tag ${tag}`, { encoding: 'utf8' });
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
  console.log(`Tagging ${tag} and pushing (triggers Docker publish)...`);
}
execSync(`git push origin ${tag}`, { stdio: 'inherit' });
