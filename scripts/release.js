#!/usr/bin/env node
/**
 * Bumps version, syncs to all packages and server.json, commits. Does NOT tag or push.
 * Run this first, then publish to npm, then run yarn release:push so the MCP registry finds the package.
 * Single source of truth: root package.json. See scripts/sync-version.js.
 *
 * Usage: yarn release [version | patch | minor | major]
 *   yarn release         → use version from root, sync, commit (no bump)
 *   yarn release 1.0.0  → set 1.0.0, sync, commit
 *   yarn release patch   → bump patch (0.1.6 → 0.1.7), sync, commit
 *   yarn release minor   → bump minor, sync, commit
 *   yarn release major   → bump major, sync, commit
 *
 * Then: yarn publish:npm  (publish to npm)
 * Then: yarn release:push (tag and push — triggers Docker + MCP workflows)
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const versionArg = process.argv[2];

function bumpVersion(current, type) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return current;
  const [, major, minor, patch] = match.map(Number);
  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  if (type === 'major') return `${major + 1}.0.0`;
  return current;
}

// Require clean working tree
const status = execSync('git status --porcelain', { encoding: 'utf8', cwd: rootDir }).trim();
if (status) {
  console.error('Working tree is not clean. Commit or stash changes before running yarn release.');
  process.exit(1);
}

let versionToSet = versionArg;
if (versionArg === 'patch' || versionArg === 'minor' || versionArg === 'major') {
  const root = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  versionToSet = bumpVersion(root.version, versionArg);
  console.log(`Bumping ${versionArg}: ${root.version} → ${versionToSet}`);
}

// Sync version from root to all packages and server.json
execSync(
  `node "${join(__dirname, 'sync-version.js')}" ${versionToSet ? `"${versionToSet}"` : ''}`,
  {
    stdio: 'inherit',
    cwd: rootDir,
  }
);

const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;

// Commit the version bump only (no tag, no push)
execSync(
  'git add package.json packages/shared/package.json packages/cli/package.json packages/server/package.json server.json',
  { cwd: rootDir }
);
execSync(`git commit -m "chore: release ${version}"`, { stdio: 'inherit', cwd: rootDir });

console.log(`\nCommitted ${version}. Next:\n  1. yarn publish:npm\n  2. yarn release:push`);
