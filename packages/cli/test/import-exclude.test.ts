import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatExclusionSummary, runImport } from '../src/import.js';

/**
 * Import-side corpus hygiene. Exclusion matches the transcript's own cwd, not
 * CC's project folder name: that name is a lossy encoding (every
 * non-alphanumeric character becomes '-'), so `/private/tmp/x` and
 * `-private-tmp-x` cannot be told apart by decoding alone.
 */

const REAL_CWD = '/home/richard/project-x';
const TMP_CWD = '/private/tmp/claude-501/bench-run';

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

function transcript(sessionId: string, cwd: string): string {
  return [
    line({
      type: 'user',
      timestamp: '2026-08-01T10:00:01.000Z',
      sessionId,
      cwd,
      uuid: 'u1',
      version: '2.1.233',
      message: { role: 'user', content: 'do the thing' }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-08-01T10:00:05.000Z',
      sessionId,
      cwd,
      uuid: 'a1',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        usage: { input_tokens: 4, output_tokens: 120 },
        content: [{ type: 'text', text: 'done' }]
      }
    })
  ].join('');
}

/** CC's folder encoding: every non-alphanumeric character becomes '-'. */
function encode(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function makeClaudeDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-exclude-'));
  const projects = path.join(root, 'claude', 'projects');
  for (const [sid, cwd] of [
    ['real0000', REAL_CWD],
    ['bench000', TMP_CWD]
  ] as const) {
    const dir = path.join(projects, encode(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), transcript(sid, cwd));
  }
  return path.join(root, 'claude');
}

function corpusDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-exclude-corpus-'));
}

describe('ccidle import --exclude', () => {
  it('drops a session whose cwd matches, and says which rule did it', async () => {
    const claudeDir = makeClaudeDir();
    const corpus = corpusDir();
    const out: string[] = [];

    const code = await runImport({
      claudeDir,
      corpusDir: corpus,
      exclude: ['/private/tmp/**'],
      out: (l) => out.push(l)
    });

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('1 session(s) imported');
    expect(out.join('\n')).toContain('excluded: 1 session(s) by /private/tmp/** → 1');
    expect(fs.existsSync(path.join(corpus, 'real0000.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(corpus, 'bench000.jsonl'))).toBe(false);
  });

  it('imports everything when the exclude list is cleared', async () => {
    const claudeDir = makeClaudeDir();
    const corpus = corpusDir();
    const out: string[] = [];

    await runImport({ claudeDir, corpusDir: corpus, exclude: [], out: (l) => out.push(l) });

    expect(out.join('\n')).toContain('2 session(s) imported');
    expect(fs.existsSync(path.join(corpus, 'bench000.jsonl'))).toBe(true);
  });

  it('removes a corpus file that a newly added rule now excludes', async () => {
    const claudeDir = makeClaudeDir();
    const corpus = corpusDir();

    await runImport({ claudeDir, corpusDir: corpus, exclude: [], out: () => {} });
    expect(fs.existsSync(path.join(corpus, 'bench000.jsonl'))).toBe(true);

    // Second pass: sources are unchanged, so this exercises the manifest fast
    // path — which must still apply the rule rather than skip past it.
    const out: string[] = [];
    await runImport({
      claudeDir,
      corpusDir: corpus,
      exclude: ['/private/tmp/**'],
      out: (l) => out.push(l)
    });

    expect(fs.existsSync(path.join(corpus, 'bench000.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(corpus, 'real0000.jsonl'))).toBe(true);
    expect(out.join('\n')).toContain('excluded: 1 session(s)');
  });

  it('re-imports a session once its rule is lifted', async () => {
    const claudeDir = makeClaudeDir();
    const corpus = corpusDir();

    await runImport({ claudeDir, corpusDir: corpus, exclude: ['/private/tmp/**'], out: () => {} });
    expect(fs.existsSync(path.join(corpus, 'bench000.jsonl'))).toBe(false);

    await runImport({ claudeDir, corpusDir: corpus, exclude: [], out: () => {} });
    expect(fs.existsSync(path.join(corpus, 'bench000.jsonl'))).toBe(true);
  });
});

describe('formatExclusionSummary', () => {
  it('reports the active rules when nothing was excluded', () => {
    expect(formatExclusionSummary(0, {}, ['/private/tmp/**'])).toBe(
      'excluded: 0 session(s); rules active: /private/tmp/**'
    );
  });

  it('says so plainly when no rules are active', () => {
    expect(formatExclusionSummary(0, {}, [])).toBe('excluded: none (no exclusion rules active)');
  });

  it('breaks the count down per rule', () => {
    expect(formatExclusionSummary(3, { '/private/tmp/**': 2, '**/scratchpad/**': 1 }, ['a'])).toBe(
      'excluded: 3 session(s) by **/scratchpad/** → 1, /private/tmp/** → 2'
    );
  });
});
