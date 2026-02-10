#!/usr/bin/env node
/**
 * Single source of truth: root package.json "version".
 * Writes it to packages/shared, packages/cli, packages/server and server.json.
 *
 * Usage: node scripts/sync-version.js [version]
 *   no arg  → read version from root package.json, sync to all files
 *   version → write version to root package.json, then sync to all files
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const rootPath = join(rootDir, 'package.json');
let root = JSON.parse(readFileSync(rootPath, 'utf8'));
const versionArg = process.argv[2];
const version = versionArg ?? root.version;

if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/.test(version)) {
  console.error('Invalid version format (expected semver)');
  process.exit(1);
}

if (versionArg) {
  root.version = version;
  writeFileSync(rootPath, JSON.stringify(root, null, 2) + '\n');
  console.log(`Updated root package.json to ${version}`);
}

const writeJson = (filePath, update) => {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const out = typeof update === 'function' ? update(data) : { ...data, ...update };
  writeFileSync(filePath, JSON.stringify(out, null, 2) + '\n');
};

writeJson(join(rootDir, 'packages/shared/package.json'), { version });
writeJson(join(rootDir, 'packages/cli/package.json'), { version });
writeJson(join(rootDir, 'packages/server/package.json'), { version });
console.log('Updated packages/shared, packages/cli, packages/server');

const serverPath = join(rootDir, 'server.json');
writeJson(serverPath, (data) => {
  data.version = version;
  if (Array.isArray(data.packages) && data.packages[0]) {
    data.packages[0].version = version;
  }
  return data;
});
console.log('Updated server.json');

console.log(`Synced version ${version} everywhere.`);
