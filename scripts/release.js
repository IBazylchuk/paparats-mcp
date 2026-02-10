#!/usr/bin/env node
/**
 * Syncs version from root to all packages and server.json, commits the bump, tags v{VERSION}, pushes branch and tag.
 * Single source of truth: root package.json. See scripts/sync-version.js.
 * Triggers .github/workflows/docker-publish.yml
 *
 * Usage: yarn release [version | patch | minor | major]
 *   yarn release         → use version from root, sync, commit, tag, push (no bump)
 *   yarn release 1.0.0   → set 1.0.0, sync, commit, tag v1.0.0, push
 *   yarn release patch   → bump patch (0.1.6 → 0.1.7), sync, commit, tag, push
 *   yarn release minor   → bump minor (0.1.6 → 0.2.0), sync, commit, tag, push
 *   yarn release major   → bump major (0.1.6 → 1.0.0), sync, commit, tag, push
 *
 * Run on a clean working tree (all changes committed). The script will create one new commit with the version bump.
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

// Require clean working tree so the version-bump commit is the only change
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

// Sync version from root to all packages and server.json (and set root if version passed)
execSync(
  `node "${join(__dirname, 'sync-version.js')}" ${versionToSet ? `"${versionToSet}"` : ''}`,
  {
    stdio: 'inherit',
    cwd: rootDir,
  }
);

const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

// Commit the version bump so the tag points to a commit that has the new version
execSync(
  'git add package.json packages/shared/package.json packages/cli/package.json packages/server/package.json server.json',
  {
    cwd: rootDir,
  }
);
execSync(`git commit -m "chore: release ${version}"`, { stdio: 'inherit', cwd: rootDir });

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
  console.log(`Tagging ${tag} and pushing (triggers Docker publish)...`);
}

execSync('git push origin HEAD', { stdio: 'inherit', cwd: rootDir });
execSync(`git push origin ${tag}`, { stdio: 'inherit', cwd: rootDir });
