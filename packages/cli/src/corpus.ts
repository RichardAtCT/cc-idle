import fs from 'node:fs';
import path from 'node:path';
import { corpusRawDir as defaultCorpusRawDir, defaultClaudeDir } from '@ccidle/shared';

/**
 * `ccidle corpus snapshot` — archival copy of raw Claude Code transcripts to
 * ~/.ccidle/corpus-raw/<date>/, so history survives CC's retention sweep
 * independent of import runs (handoff §4). Rsync-style: source is opened
 * read-only, unchanged files (same size+mtime at the destination) are
 * skipped, mtimes are preserved on copies.
 */

export interface SnapshotOptions {
  claudeDir?: string;
  corpusRawDir?: string;
  /** YYYY-MM-DD tree name; defaults to today (UTC). Injectable for tests. */
  date?: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
}

export interface SnapshotSummary {
  copied: number;
  skipped: number;
  bytes: number;
  destDir: string;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files.sort();
}

export async function runCorpusSnapshot(options: SnapshotOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const env = options.env ?? process.env;
  const claudeDir = options.claudeDir ?? defaultClaudeDir(env);
  const projectsRoot = path.join(claudeDir, 'projects');
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`ccidle corpus snapshot: --date must be YYYY-MM-DD, got "${date}"`);
    return 1;
  }
  const destRoot = path.join(options.corpusRawDir ?? defaultCorpusRawDir(env), date);

  if (!fs.existsSync(projectsRoot)) {
    console.error(`ccidle corpus snapshot: no transcripts dir at ${projectsRoot}`);
    return 1;
  }

  const summary: SnapshotSummary = { copied: 0, skipped: 0, bytes: 0, destDir: destRoot };
  for (const source of walkFiles(projectsRoot)) {
    const rel = path.relative(projectsRoot, source);
    const dest = path.join(destRoot, rel);
    let srcStat: fs.Stats;
    try {
      srcStat = fs.statSync(source);
    } catch {
      continue; // vanished mid-walk — CC may be writing; skip, never touch source
    }
    try {
      const destStat = fs.statSync(dest);
      // sub-ms float precision is lossy through utimes — <1ms counts as equal
      if (destStat.size === srcStat.size && Math.abs(destStat.mtimeMs - srcStat.mtimeMs) < 1) {
        summary.skipped += 1;
        continue;
      }
    } catch {
      // destination missing — copy below
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      fs.utimesSync(dest, srcStat.atimeMs / 1000, srcStat.mtimeMs / 1000);
      summary.copied += 1;
      summary.bytes += srcStat.size;
    } catch (error) {
      out(`  skip ${rel}: ${(error as Error).message}`);
    }
  }

  out(
    `ccidle corpus snapshot: ${summary.copied} file(s) copied (${summary.bytes.toLocaleString('en-US')} bytes), ` +
      `${summary.skipped} unchanged → ${destRoot}`
  );
  return 0;
}
