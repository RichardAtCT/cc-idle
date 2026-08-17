import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCorpusSnapshot } from '../src/corpus.js';
import { transcriptRetentionCheck } from '../src/doctor.js';

function makeClaudeDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-snap-'));
  const claudeDir = path.join(root, 'claude');
  const proj = path.join(claudeDir, 'projects', '-home-r-proj');
  fs.mkdirSync(path.join(proj, 'sess-1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(proj, 'sess-1', 'subagents', 'agent-a.jsonl'), '{"type":"assistant"}\n');
  return claudeDir;
}

describe('ccidle corpus snapshot', () => {
  it('copies the raw tree, preserves layout, and skips unchanged files on re-run', async () => {
    const claudeDir = makeClaudeDir();
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-raw-'));
    const out: string[] = [];
    const code = await runCorpusSnapshot({ claudeDir, corpusRawDir: rawDir, date: '2026-08-17', out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('2 file(s) copied');
    const dest = path.join(rawDir, '2026-08-17', '-home-r-proj');
    expect(fs.readFileSync(path.join(dest, 'sess-1.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
    expect(fs.existsSync(path.join(dest, 'sess-1', 'subagents', 'agent-a.jsonl'))).toBe(true);

    // rsync-style: second run copies nothing
    const out2: string[] = [];
    await runCorpusSnapshot({ claudeDir, corpusRawDir: rawDir, date: '2026-08-17', out: (l) => out2.push(l) });
    expect(out2.join('\n')).toContain('0 file(s) copied');
    expect(out2.join('\n')).toContain('2 unchanged');
  });

  it('rejects malformed --date and missing source dirs', async () => {
    const claudeDir = makeClaudeDir();
    expect(await runCorpusSnapshot({ claudeDir, corpusRawDir: os.tmpdir(), date: 'nope', out: () => {} })).toBe(1);
    expect(
      await runCorpusSnapshot({ claudeDir: path.join(claudeDir, 'missing'), corpusRawDir: os.tmpdir(), date: '2026-01-01', out: () => {} })
    ).toBe(1);
  });
});

describe('doctor transcript-retention check', () => {
  function settingsFixture(content: string | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-ret-'));
    const p = path.join(dir, 'settings.json');
    if (content !== null) fs.writeFileSync(p, content);
    return p;
  }

  it('warns when cleanupPeriodDays is unset (default settings fixture)', () => {
    const check = transcriptRetentionCheck(settingsFixture('{"hooks":{}}'));
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('cleanupPeriodDays is not set');
    expect(check.detail).toContain('not 0');
  });

  it('warns when cleanupPeriodDays ≤ 30', () => {
    const check = transcriptRetentionCheck(settingsFixture('{"cleanupPeriodDays": 30}'));
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('cleanupPeriodDays=30');
  });

  it('passes when cleanupPeriodDays is large', () => {
    const check = transcriptRetentionCheck(settingsFixture('{"cleanupPeriodDays": 3650}'));
    expect(check.status).toBe('ok');
  });

  it('warns (not crashes) when settings.json is missing entirely', () => {
    const check = transcriptRetentionCheck(settingsFixture(null));
    expect(check.status).toBe('warn');
  });
});
