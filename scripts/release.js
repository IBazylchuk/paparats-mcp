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
const tag = `v${version}`;

console.log(`Tagging ${tag} and pushing (triggers Docker publish)...`);
execSync(`git tag ${tag} && git push origin ${tag}`, { stdio: 'inherit' });
