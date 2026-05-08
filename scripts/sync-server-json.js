#!/usr/bin/env node
/**
 * Post-version hook for Changesets: read the bumped version from
 * packages/cli/package.json (the published source of truth that ends up on
 * npm — Changesets does not touch the root package.json) and write it to
 * server.json. Keeps the MCP registry server.json in sync with the npm
 * package version. Run automatically by the Changesets workflow after
 * `changeset version`.
 *
 * Why packages/cli, not root: Changesets bumps versions inside workspace
 * packages, not the root package.json. We treat @paparats/cli's version as
 * canonical because its npm version is what server.json's packages[0]
 * references; the MCP registry validates that pair.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const cliPkg = JSON.parse(readFileSync(join(rootDir, 'packages/cli/package.json'), 'utf8'));
const version = cliPkg.version;

if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/.test(version)) {
  console.error(`Invalid version in packages/cli/package.json: ${version}`);
  process.exit(1);
}

const rootPath = join(rootDir, 'package.json');
const root = JSON.parse(readFileSync(rootPath, 'utf8'));
if (root.version !== version) {
  root.version = version;
  writeFileSync(rootPath, JSON.stringify(root, null, 2) + '\n');
  console.log(`Updated root package.json to ${version}`);
}

const serverPath = join(rootDir, 'server.json');
const serverData = JSON.parse(readFileSync(serverPath, 'utf8'));
serverData.version = version;
if (Array.isArray(serverData.packages) && serverData.packages[0]) {
  serverData.packages[0].version = version;
}
writeFileSync(serverPath, JSON.stringify(serverData, null, 2) + '\n');
console.log(`Updated server.json to ${version}`);
