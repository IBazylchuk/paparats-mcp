import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const COMPLETE_MARKER = '.bench-source-complete';

/** Top-level directory of the git repository containing `dir`. */
export function gitTopLevel(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

/** HEAD commit of `dir`, or null when it is not a git checkout. */
export function gitHead(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Whether `dir` has uncommitted changes to tracked files. */
export function gitDirty(dir: string): boolean {
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Export the tracked files of `commit` into `<cacheDir>/src/<commit>` with
 * `git archive` and return that directory. The export is reused on later runs.
 * Indexing a snapshot rather than the working tree keeps the corpus exactly
 * what the labels were taken from, whatever branch is checked out.
 */
export async function exportCommit(
  repoRoot: string,
  commit: string,
  cacheDir: string
): Promise<string> {
  const dest = path.join(cacheDir, 'src', commit);
  if (fs.existsSync(path.join(dest, COMPLETE_MARKER))) return dest;

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const archive = spawn('git', ['-C', repoRoot, 'archive', '--format=tar', commit], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tar = spawn('tar', ['-x', '-f', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  archive.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  tar.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  archive.stdout.pipe(tar.stdin);
  const exitCode = (child: ReturnType<typeof spawn>): Promise<number | null> =>
    new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
  const [archiveCode, tarCode] = await Promise.all([exitCode(archive), exitCode(tar)]);
  if (archiveCode !== 0 || tarCode !== 0) {
    throw new Error(
      `Exporting ${commit} failed: ${stderr.trim() || `git exit ${archiveCode}, tar exit ${tarCode}`}`
    );
  }

  fs.writeFileSync(path.join(dest, COMPLETE_MARKER), `${commit}\n`);
  return dest;
}
