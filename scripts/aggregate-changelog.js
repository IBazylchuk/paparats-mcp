#!/usr/bin/env node
/**
 * Post-version hook for Changesets: aggregate per-package changelogs into
 * the root CHANGELOG.md so users have one place to see all releases.
 *
 * Why this exists: Changesets writes entries only into packages/<name>/CHANGELOG.md,
 * which is right for independent monorepos but unhelpful here — all four
 * packages are `fixed`-versioned and ship together, and users land on the
 * root CHANGELOG.md first. We mirror each version section into the root
 * file inside a marker-delimited block. The block is fully rewritten on
 * every run, which gives idempotency for free and lets us also backfill
 * any historical post-Changesets versions that were missed.
 *
 * Source of truth: packages/server/CHANGELOG.md. With `fixed` versioning,
 * all four packages have identical entry bodies, so reading one is enough.
 * Dates come from `git log` against the changelog file (the commit that
 * added the version's heading), falling back to today.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const ROOT_CHANGELOG = join(rootDir, 'CHANGELOG.md');
const SOURCE_CHANGELOG = join(rootDir, 'packages/server/CHANGELOG.md');
const SOURCE_CHANGELOG_REL = relative(rootDir, SOURCE_CHANGELOG);
const BEGIN_MARKER = '<!-- BEGIN AGGREGATED -->';
const END_MARKER = '<!-- END AGGREGATED -->';

const PACKAGES = ['@paparats/shared', '@paparats/cli', '@paparats/server', '@paparats/indexer'];

const INTRO = `> **Releases from 0.3.0 onward** are aggregated automatically from per-package Changesets entries by \`scripts/aggregate-changelog.js\`. Per-package detail lives in \`packages/<name>/CHANGELOG.md\`. Entries for **0.2.24 and earlier** are the historical monorepo-level archive (preserved below the aggregated block).`;

function parseSourceChangelog(content) {
  const lines = content.split('\n');
  const versions = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^## (\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\s*$/);
    if (m) {
      if (current) versions.push(current);
      current = { version: m[1], bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) versions.push(current);
  return versions.map(({ version, bodyLines }) => ({
    version,
    body: bodyLines.join('\n').trim(),
  }));
}

function findVersionDate(version) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) return null;
  try {
    const out = execFileSync(
      'git',
      ['log', '--diff-filter=A', `-S## ${version}`, '--format=%aI', '--', SOURCE_CHANGELOG_REL],
      { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (!out) return null;
    return out.split('\n')[0].slice(0, 10);
  } catch {
    return null;
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function renderSection({ version, body, date }) {
  const pkgList = PACKAGES.join(', ');
  return [`## [${version}] - ${date}`, '', `**Packages:** ${pkgList}`, '', body, ''].join('\n');
}

function buildAggregatedBlock(versions) {
  const sections = versions.map((v) => {
    const date = findVersionDate(v.version) ?? todayIso();
    return renderSection({ ...v, date });
  });
  return [BEGIN_MARKER, '', INTRO, '', ...sections, END_MARKER].join('\n');
}

function updateRootChangelog(aggregatedBlock) {
  const existing = readFileSync(ROOT_CHANGELOG, 'utf8');
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);

  let next;
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin).trimEnd();
    const after = existing.slice(end + END_MARKER.length).trimStart();
    next = `${before}\n\n${aggregatedBlock}\n\n${after}\n`;
  } else {
    const headingMatch = existing.match(/^# Changelog\s*\n/);
    if (!headingMatch) {
      throw new Error('Root CHANGELOG.md must start with "# Changelog"');
    }
    const headingEnd = headingMatch[0].length;
    const rest = existing.slice(headingEnd);
    const firstSection = rest.search(/^## /m);
    const archive = firstSection === -1 ? '' : rest.slice(firstSection);
    next = `# Changelog\n\n${aggregatedBlock}\n\n${archive}`;
  }

  next = next.replace(/\n{3,}/g, '\n\n');
  if (!next.endsWith('\n')) next += '\n';

  if (next === existing) {
    console.log('Root CHANGELOG.md already up to date');
    return false;
  }
  writeFileSync(ROOT_CHANGELOG, next);
  return true;
}

function main() {
  const sourceContent = readFileSync(SOURCE_CHANGELOG, 'utf8');
  const versions = parseSourceChangelog(sourceContent);
  if (versions.length === 0) {
    console.log('No version sections found in packages/server/CHANGELOG.md');
    return;
  }
  const block = buildAggregatedBlock(versions);
  const changed = updateRootChangelog(block);
  if (changed) {
    console.log(
      `Aggregated ${versions.length} version(s) into root CHANGELOG.md: ${versions.map((v) => v.version).join(', ')}`
    );
  }
}

main();
