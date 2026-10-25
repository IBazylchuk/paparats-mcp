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
 * Sources: all four packages/<name>/CHANGELOG.md files. `fixed` versioning
 * keeps the version numbers in step, but an entry lands only in the
 * changelogs of the packages its changeset names, so they are merged.
 * Dates come from the `vX.Y.Z` tag, then from the date the root
 * CHANGELOG.md already shows for that version, falling back to today.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const ROOT_CHANGELOG = join(rootDir, 'CHANGELOG.md');
const BEGIN_MARKER = '<!-- BEGIN AGGREGATED -->';
const END_MARKER = '<!-- END AGGREGATED -->';

const PACKAGES = ['@paparats/shared', '@paparats/cli', '@paparats/server', '@paparats/indexer'];
const SOURCE_CHANGELOGS = PACKAGES.map((name) =>
  join(rootDir, 'packages', name.replace('@paparats/', ''), 'CHANGELOG.md')
);

const INTRO = `> **Releases from 0.3.0 onward** are aggregated automatically from per-package Changesets entries by \`scripts/aggregate-changelog.js\`. Per-package detail lives in \`packages/<name>/CHANGELOG.md\`. Entries for **0.2.24 and earlier** are the historical monorepo-level archive (preserved below the aggregated block).`;

const SECTION_ORDER = ['Major Changes', 'Minor Changes', 'Patch Changes'];

/**
 * Parse one package changelog into `version -> { section -> entries[] }`.
 * An entry is a top-level `- ` bullet with every line up to the next bullet
 * or heading.
 */
function parsePackageChangelog(content) {
  const versions = new Map();
  let entries = null;
  let current = null;
  for (const line of content.split(/\r?\n/)) {
    const versionMatch = line.match(/^## (\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\s*$/);
    if (versionMatch) {
      entries = new Map();
      versions.set(versionMatch[1], entries);
      current = null;
      continue;
    }
    if (!entries) continue;
    const sectionMatch = line.match(/^### (.+?)\s*$/);
    if (sectionMatch) {
      if (!entries.has(sectionMatch[1])) entries.set(sectionMatch[1], []);
      current = { list: entries.get(sectionMatch[1]), lines: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('- ')) {
      current.lines = [line];
      current.list.push(current.lines);
    } else if (current.lines) {
      current.lines.push(line);
    }
  }
  return versions;
}

/**
 * Strip noise that `@changesets/changelog-github` injects into entries but
 * that has no value in an aggregated single-maintainer view: `Thanks
 * [@user](url)! - ` prefixes, and dependency-bump lines (`Updated
 * dependencies`, `@paparats/<name>@x.y.z`) — under `fixed` versioning every
 * package always bumps to the same version, so they are pure boilerplate.
 * Returns null for an entry that is nothing but such a line.
 */
const DEPENDENCY_LINE = /^\s*- (?:Updated dependencies|@paparats\/\S+@\S+\s*$)/;

function cleanEntry(lines) {
  if (DEPENDENCY_LINE.test(lines[0])) return null;
  const kept = lines.filter((line) => !DEPENDENCY_LINE.test(line));
  const text = kept
    .join('\n')
    .replace(/(\) )Thanks \[@[^\]]+\]\([^)]+\)! - /g, '$1')
    .trimEnd();
  return text || null;
}

/**
 * Merge every package's entries per version. A changeset that bumps several
 * packages appears in each of their changelogs with the same text, so entries
 * are de-duplicated; one that bumps a single package (say a CLI-only fix)
 * exists only in that package's changelog, which is why reading one file is
 * not enough.
 */
function mergePackageChangelogs(parsed) {
  const merged = new Map();
  for (const versions of parsed) {
    for (const [version, sections] of versions) {
      if (!merged.has(version)) merged.set(version, new Map());
      const target = merged.get(version);
      for (const [section, entries] of sections) {
        if (!target.has(section)) target.set(section, []);
        const list = target.get(section);
        for (const lines of entries) {
          const text = cleanEntry(lines);
          if (text && !list.includes(text)) list.push(text);
        }
      }
    }
  }
  return [...merged.entries()]
    .sort(([a], [b]) => compareVersionsDesc(a, b))
    .map(([version, sections]) => ({ version, body: renderBody(sections) }));
}

function compareVersionsDesc(a, b) {
  const [coreA, preA] = a.split('-', 2);
  const [coreB, preB] = b.split('-', 2);
  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] !== partsB[i]) return partsB[i] - partsA[i];
  }
  if (preA === preB) return 0;
  if (preA === undefined) return -1;
  if (preB === undefined) return 1;
  return preB.localeCompare(preA, 'en', { numeric: true });
}

// A multi-paragraph entry is followed by a blank line, as Changesets writes it.
function joinEntries(entries) {
  return entries
    .map((text, i) => (i < entries.length - 1 && text.includes('\n\n') ? `${text}\n` : text))
    .join('\n');
}

function renderBody(sections) {
  const names = [
    ...SECTION_ORDER.filter((name) => sections.has(name)),
    ...[...sections.keys()].filter((name) => !SECTION_ORDER.includes(name)),
  ];
  const parts = names
    .filter((name) => sections.get(name).length > 0)
    .map((name) => `### ${name}\n\n${joinEntries(sections.get(name))}`);
  return parts.length > 0 ? parts.join('\n\n') : 'Dependency updates only.';
}

/**
 * Resolve the release date for a version. Prefer the `vX.Y.Z` git tag's
 * commit date — that's the moment `yarn release:local` actually published.
 * Versions that don't have a tag yet (e.g. a release PR is open but not
 * yet published) keep the date the root CHANGELOG already shows, or get
 * today on their first run; the next run after the tag lands
 * will rewrite the section with the correct date.
 *
 * We deliberately avoid `git log -S/-G` against the changelog file — both
 * miss commits where the marker already existed elsewhere in the diff,
 * which falsely collapses multiple version bumps onto the same date.
 */
function findVersionDate(version) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) return null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%aI', `v${version}`], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    return out.split(/\r?\n/)[0].slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Dates the root CHANGELOG.md already shows, by version. A version that was
 * never tagged (a release PR that was folded into the next one) keeps the
 * date it got when it was first aggregated instead of moving to today on
 * every run.
 */
function readRecordedDates() {
  const dates = new Map();
  let existing;
  try {
    existing = readFileSync(ROOT_CHANGELOG, 'utf8');
  } catch {
    return dates;
  }
  for (const match of existing.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm)) {
    if (!dates.has(match[1])) dates.set(match[1], match[2]);
  }
  return dates;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function renderSection({ version, body, date }) {
  const pkgList = PACKAGES.join(', ');
  return [`## [${version}] - ${date}`, '', `**Packages:** ${pkgList}`, '', body, ''].join('\n');
}

function buildAggregatedBlock(versions) {
  const recorded = readRecordedDates();
  const sections = versions.map((v) => {
    const date = findVersionDate(v.version) ?? recorded.get(v.version) ?? todayIso();
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
  const versions = mergePackageChangelogs(
    SOURCE_CHANGELOGS.map((file) => parsePackageChangelog(readFileSync(file, 'utf8')))
  );
  if (versions.length === 0) {
    console.log('No version sections found in packages/*/CHANGELOG.md');
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
