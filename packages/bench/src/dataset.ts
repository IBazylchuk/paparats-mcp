import fs from 'node:fs';
import path from 'node:path';
import type { BenchQuery, Dataset, DatasetProject, ExpectedLocation } from './types.js';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TYPE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Raised when a dataset file does not match the schema; lists every problem found. */
export class DatasetError extends Error {
  constructor(
    readonly source: string,
    readonly problems: string[]
  ) {
    super(`Invalid dataset ${source}:\n  - ${problems.join('\n  - ')}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function parseExpected(raw: unknown, where: string, problems: string[]): ExpectedLocation | null {
  if (!isRecord(raw)) {
    problems.push(`${where}: expected an object`);
    return null;
  }
  const { file, startLine, endLine, symbol } = raw;
  if (typeof file !== 'string' || file.trim() === '') {
    problems.push(`${where}.file: expected a non-empty string`);
    return null;
  }
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    problems.push(`${where}.file: must be relative to the project root, got "${file}"`);
    return null;
  }
  const out: ExpectedLocation = { file };
  if (startLine !== undefined || endLine !== undefined) {
    if (!isPositiveInt(startLine) || !isPositiveInt(endLine)) {
      problems.push(`${where}: startLine and endLine must both be positive integers`);
      return null;
    }
    if (endLine < startLine) {
      problems.push(`${where}: endLine ${endLine} is before startLine ${startLine}`);
      return null;
    }
    out.startLine = startLine;
    out.endLine = endLine;
  }
  if (symbol !== undefined) {
    if (typeof symbol !== 'string' || symbol === '') {
      problems.push(`${where}.symbol: expected a non-empty string`);
      return null;
    }
    out.symbol = symbol;
  }
  return out;
}

function parseQuery(
  raw: unknown,
  index: number,
  projects: Set<string>,
  problems: string[]
): BenchQuery | null {
  const where = `queries[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${where}: expected an object`);
    return null;
  }
  const { id, type, query, project, expected, notes } = raw;
  const before = problems.length;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    problems.push(`${where}.id: expected an identifier like "nl-001"`);
  }
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) {
    problems.push(`${where}.type: expected a lower-case kebab name like "identifier"`);
  }
  if (typeof query !== 'string' || query.trim() === '') {
    problems.push(`${where}.query: expected a non-empty string`);
  }
  if (typeof project !== 'string' || !projects.has(project)) {
    problems.push(`${where}.project: must name one of the dataset's projects`);
  }
  if (notes !== undefined && typeof notes !== 'string') {
    problems.push(`${where}.notes: expected a string`);
  }
  if (!Array.isArray(expected) || expected.length === 0) {
    problems.push(`${where}.expected: expected a non-empty array`);
    return null;
  }
  const locations = expected.map((e, i) => parseExpected(e, `${where}.expected[${i}]`, problems));
  if (problems.length > before) return null;
  return {
    id: id as string,
    type: type as string,
    query: query as string,
    project: project as string,
    expected: locations as ExpectedLocation[],
    ...(notes !== undefined ? { notes: notes as string } : {}),
  };
}

/** Validate an already-parsed JSON value as a dataset. Throws {@link DatasetError}. */
export function parseDataset(raw: unknown, source = 'dataset'): Dataset {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new DatasetError(source, ['expected a JSON object']);

  const { name, description, commit, projects, queries } = raw;
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push('name: expected a non-empty string');
  }
  if (description !== undefined && typeof description !== 'string') {
    problems.push('description: expected a string');
  }
  if (typeof commit !== 'string' || !SHA_PATTERN.test(commit)) {
    problems.push('commit: expected a full 40-character lower-case commit SHA');
  }

  const parsedProjects: DatasetProject[] = [];
  if (!Array.isArray(projects) || projects.length === 0) {
    problems.push('projects: expected a non-empty array');
  } else {
    projects.forEach((p, i) => {
      if (!isRecord(p) || typeof p.name !== 'string' || p.name.trim() === '') {
        problems.push(`projects[${i}].name: expected a non-empty string`);
        return;
      }
      if (p.path !== undefined && typeof p.path !== 'string') {
        problems.push(`projects[${i}].path: expected a string`);
        return;
      }
      parsedProjects.push({ name: p.name, ...(p.path !== undefined ? { path: p.path } : {}) });
    });
  }
  const projectNames = new Set(parsedProjects.map((p) => p.name));
  if (projectNames.size !== parsedProjects.length) problems.push('projects: duplicate name');

  const parsedQueries: BenchQuery[] = [];
  if (!Array.isArray(queries) || queries.length === 0) {
    problems.push('queries: expected a non-empty array');
  } else {
    const seen = new Set<string>();
    queries.forEach((q, i) => {
      const parsed = parseQuery(q, i, projectNames, problems);
      if (!parsed) return;
      if (seen.has(parsed.id)) problems.push(`queries[${i}].id: duplicate id "${parsed.id}"`);
      seen.add(parsed.id);
      parsedQueries.push(parsed);
    });
  }

  if (problems.length > 0) throw new DatasetError(source, problems);
  return {
    name: name as string,
    ...(description !== undefined ? { description: description as string } : {}),
    commit: commit as string,
    projects: parsedProjects,
    queries: parsedQueries,
  };
}

export function loadDataset(file: string): Dataset {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read dataset ${file}: ${(err as Error).message}`, { cause: err });
  }
  return parseDataset(raw, file);
}

/** Label problems found by checking a dataset against the source tree it was taken from. */
export function checkLabels(
  dataset: Dataset,
  readFile: (project: DatasetProject, file: string) => string | null
): string[] {
  const problems: string[] = [];
  const projects = new Map(dataset.projects.map((p) => [p.name, p]));
  for (const q of dataset.queries) {
    const project = projects.get(q.project);
    if (!project) continue;
    q.expected.forEach((e, i) => {
      const where = `${q.id} expected[${i}] ${e.file}`;
      const content = readFile(project, e.file);
      if (content === null) {
        problems.push(`${where}: file not found`);
        return;
      }
      const lines = content.split('\n');
      if (e.endLine !== undefined && e.endLine > lines.length) {
        problems.push(`${where}: endLine ${e.endLine} is past the end (${lines.length} lines)`);
        return;
      }
      if (e.symbol !== undefined) {
        const span =
          e.startLine !== undefined && e.endLine !== undefined
            ? lines.slice(e.startLine - 1, e.endLine).join('\n')
            : content;
        if (!span.includes(e.symbol)) {
          problems.push(`${where}: symbol "${e.symbol}" does not appear in the labelled lines`);
        }
      }
    });
  }
  return problems;
}
