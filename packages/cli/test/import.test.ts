import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEventLine, TokenUsagePayloadSchema, type EventEnvelope } from '@ccidle/shared';
import { buildRedactor, synthesizeSessionEvents } from '../src/transcript-import.js';
import { discoverSessions, encodeProjectPath, projectMatches, runImport } from '../src/import.js';

// ---- fixture builders: the schema variants recorded in docs/decisions.md §2 ----

const SID = 'aaaa1111-2222-3333-4444-555566667777';
const CWD = '/home/richard/project-x';

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

/** v2.1.x layout: one API response streamed as several lines repeating message.id + usage. */
function modernTranscript(): string {
  const usage = {
    input_tokens: 4,
    output_tokens: 120,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 900
  };
  return [
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-01T10:00:00.000Z', sessionId: SID }),
    line({
      type: 'user',
      timestamp: '2026-08-01T10:00:01.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'u1',
      version: '2.1.233',
      message: { role: 'user', content: 'fix the tests sk-abcdefghij1234 please' }
    }),
    // one response, three streamed lines, identical usage — must count ONCE
    line({
      type: 'assistant',
      timestamp: '2026-08-01T10:00:05.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'a1',
      requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-fable-5', usage, content: [{ type: 'thinking', thinking: 'hm' }] }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-08-01T10:00:06.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'a2',
      requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-fable-5', usage, content: [{ type: 'text', text: 'on it' }] }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-08-01T10:00:07.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'a3',
      requestId: 'req_1',
      message: {
        id: 'msg_1',
        model: 'claude-fable-5',
        usage,
        content: [{ type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { command: 'pnpm test' } }]
      }
    }),
    line({
      type: 'user',
      timestamp: '2026-08-01T10:00:09.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'u2',
      toolUseResult: { ok: true },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ok', is_error: false }] }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-08-01T10:00:12.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'a4',
      requestId: 'req_2',
      message: {
        id: 'msg_2',
        model: 'claude-fable-5',
        usage: { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 6000, cache_creation_input_tokens: 10 },
        content: [{ type: 'tool_use', id: 'toolu_fail', name: 'Edit', input: { file_path: '/x' } }]
      }
    }),
    line({
      type: 'user',
      timestamp: '2026-08-01T10:00:14.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'u3',
      toolUseResult: 'error',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fail', is_error: true }] }
    }),
    // second human turn ends the first
    line({
      type: 'user',
      timestamp: '2026-08-01T10:05:00.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'u4',
      message: { role: 'user', content: [{ type: 'text', text: 'thanks, now ship it' }] }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-08-01T10:05:20.000Z',
      sessionId: SID,
      cwd: CWD,
      uuid: 'a5',
      requestId: 'req_3',
      message: {
        id: 'msg_3',
        model: 'claude-opus-5',
        usage: { input_tokens: 9, output_tokens: 77, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'done' }]
      }
    }),
    line({ type: 'last-prompt', sessionId: SID, lastPrompt: 'x', leafUuid: 'a5' })
  ].join('');
}

/** Pre-streaming legacy layout: no requestId/message.id repeats, no cache fields, string content. */
function legacyTranscript(sid: string): string {
  return [
    line({
      type: 'user',
      timestamp: '2025-11-02T08:00:00.000Z',
      sessionId: sid,
      cwd: '/home/richard/legacy',
      uuid: 'lu1',
      message: { role: 'user', content: 'hello old world' }
    }),
    line({
      type: 'assistant',
      timestamp: '2025-11-02T08:00:04.000Z',
      sessionId: sid,
      cwd: '/home/richard/legacy',
      uuid: 'la1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        usage: { input_tokens: 100, output_tokens: 55 },
        content: [{ type: 'text', text: 'hi' }]
      }
    })
  ].join('');
}

/** Inline-sidechain layout: subagent lines share the file with isSidechain: true. */
function sidechainTranscript(sid: string): string {
  return [
    line({
      type: 'user',
      timestamp: '2026-01-05T12:00:00.000Z',
      sessionId: sid,
      cwd: '/home/richard/side',
      uuid: 'm1',
      message: { role: 'user', content: 'spawn an agent' }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-01-05T12:00:02.000Z',
      sessionId: sid,
      cwd: '/home/richard/side',
      uuid: 'm2',
      message: {
        id: 'msg_main',
        model: 'claude-fable-5',
        usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: {} }]
      }
    }),
    line({
      type: 'user',
      timestamp: '2026-01-05T12:00:03.000Z',
      sessionId: sid,
      isSidechain: true,
      uuid: 's1',
      parentUuid: null,
      message: { role: 'user', content: 'agent prompt' }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-01-05T12:02:03.000Z',
      sessionId: sid,
      isSidechain: true,
      uuid: 's2',
      parentUuid: 's1',
      message: {
        id: 'msg_side',
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'agent done' }]
      }
    }),
    line({
      type: 'user',
      timestamp: '2026-01-05T12:02:05.000Z',
      sessionId: sid,
      cwd: '/home/richard/side',
      uuid: 'm3',
      toolUseResult: { ok: true },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task', is_error: false }] }
    })
  ].join('');
}

function malformedTranscript(sid: string): string {
  return [
    '{"type":"user","timestamp":"2026-02-01T09:00:00.000Z","sessionId":"' + sid + '","cwd":"/p/m","uuid":"x1","message":{"content":"ok line"}}\n',
    'this is not json at all\n',
    '{"type":"assistant","timestamp":"2026-02-01T09:00:05.000Z","sessionId":"' + sid + '","cwd":"/p/m","uuid":"x2","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2},"content":[]}}\n',
    '{"truncated": tru\n',
    '[1,2,3]\n'
  ].join('');
}

// ---- synthesis unit tests ----

describe('synthesizeSessionEvents', () => {
  it('synthesizes the full event set from a modern (v2.1.x) transcript', () => {
    const result = synthesizeSessionEvents(modernTranscript(), { fallbackSessionId: 'fallback' });
    expect(result.sessionId).toBe(SID);
    const events = result.envelopes.map((e) => e.event);
    expect(events[0]).toBe('SessionStart');
    expect(events[events.length - 1]).toBe('SessionEnd');
    expect(result.stats.byEvent.UserPromptSubmit).toBe(2);
    expect(result.stats.byEvent.PreToolUse).toBe(2);
    expect(result.stats.byEvent.PostToolUse).toBe(2);
    expect(result.stats.byEvent.Stop).toBe(2); // one per completed turn
    expect(result.stats.byEvent.TokenUsage).toBe(3); // msg_1 deduped, msg_2, msg_3
    // every envelope is tagged and byte-compatible with the native stream
    for (const envelope of result.envelopes) {
      expect((envelope as Record<string, unknown>).origin).toBe('import');
      const roundTripped = parseEventLine(JSON.stringify(envelope));
      expect(roundTripped).not.toBeNull();
      expect((roundTripped as Record<string, unknown>).origin).toBe('import');
    }
  });

  it('dedupes streamed usage by message.id — token totals reconcile ±0 with the raw transcript', () => {
    const result = synthesizeSessionEvents(modernTranscript(), { fallbackSessionId: SID });
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const envelope of result.envelopes) {
      if (envelope.event !== 'TokenUsage') continue;
      const parsed = TokenUsagePayloadSchema.parse(envelope.payload);
      for (const t of Object.values(parsed.byModel)) {
        totals.input += t.inputTokens;
        totals.output += t.outputTokens;
        totals.cacheRead += t.cacheReadTokens;
        totals.cacheWrite += t.cacheWriteTokens;
      }
    }
    // raw transcript truth: msg_1 (4/120/5000/900) once + msg_2 (2/40/6000/10) + msg_3 (9/77/0/0)
    expect(totals).toEqual({ input: 15, output: 237, cacheRead: 11000, cacheWrite: 910 });
  });

  it('marks failed tool calls so the engine counts failures', () => {
    const result = synthesizeSessionEvents(modernTranscript(), { fallbackSessionId: SID });
    const posts = result.envelopes.filter((e) => e.event === 'PostToolUse');
    const failed = posts.find((e) => e.tool === 'Edit');
    const ok = posts.find((e) => e.tool === 'Bash');
    expect((failed?.payload.tool_response as { is_error: boolean }).is_error).toBe(true);
    expect((ok?.payload.tool_response as { is_error: boolean }).is_error).toBe(false);
  });

  it('handles the legacy pre-streaming layout (no cache fields, string content)', () => {
    const result = synthesizeSessionEvents(legacyTranscript('legacy-1'), { fallbackSessionId: 'legacy-1' });
    expect(result.stats.byEvent.UserPromptSubmit).toBe(1);
    expect(result.stats.byEvent.Stop).toBe(1);
    const usage = result.envelopes.find((e) => e.event === 'TokenUsage');
    const parsed = TokenUsagePayloadSchema.parse(usage!.payload);
    expect(parsed.byModel['claude-3-5-sonnet-20241022']).toEqual({
      inputTokens: 100,
      outputTokens: 55,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    });
  });

  it('groups inline sidechains into SubagentStop with duration, attributing tokens to the session', () => {
    const result = synthesizeSessionEvents(sidechainTranscript('side-1'), { fallbackSessionId: 'side-1' });
    const stops = result.envelopes.filter((e) => e.event === 'SubagentStop');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.payload.duration_ms).toBe(120_000);
    // sidechain prompt is NOT a human turn
    expect(result.stats.byEvent.UserPromptSubmit).toBe(1);
    // sidechain usage still counts (2 TokenUsage: main + side)
    expect(result.stats.byEvent.TokenUsage).toBe(2);
  });

  it('emits one SubagentStop per subagents/*.jsonl sidecar file', () => {
    const sidecar = [
      line({ type: 'user', timestamp: '2026-03-01T10:00:00.000Z', uuid: 'sa1', message: { content: 'go' } }),
      line({
        type: 'assistant',
        timestamp: '2026-03-01T10:03:30.000Z',
        uuid: 'sa2',
        message: {
          id: 'msg_sub',
          model: 'claude-haiku-4-5-20251001',
          usage: { input_tokens: 3, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'done' }]
        }
      })
    ].join('');
    const result = synthesizeSessionEvents(legacyTranscript('with-sub'), {
      fallbackSessionId: 'with-sub',
      subagentContents: [sidecar]
    });
    const stop = result.envelopes.find((e) => e.event === 'SubagentStop');
    expect(stop?.payload.duration_ms).toBe(210_000);
    expect(result.stats.byEvent.TokenUsage).toBe(2);
  });

  it('skips and counts malformed lines without aborting the file', () => {
    const result = synthesizeSessionEvents(malformedTranscript('mal-1'), { fallbackSessionId: 'mal-1' });
    expect(result.stats.malformedLines).toBe(3);
    expect(result.stats.byEvent.UserPromptSubmit).toBe(1);
    expect(result.stats.byEvent.TokenUsage).toBe(1);
  });

  it('applies redaction patterns to payload strings before writing', () => {
    const redact = buildRedactor(['sk-[A-Za-z0-9-]{10,}']);
    const result = synthesizeSessionEvents(modernTranscript(), { fallbackSessionId: SID, redact });
    const prompt = result.envelopes.find((e) => e.event === 'UserPromptSubmit');
    expect(prompt?.payload.prompt).toContain('[REDACTED]');
    expect(JSON.stringify(result.envelopes)).not.toContain('sk-abcdefghij1234');
  });

  it('preserves original timestamps and orders the timeline chronologically', () => {
    const result = synthesizeSessionEvents(modernTranscript(), { fallbackSessionId: SID });
    const tss = result.envelopes.map((e) => Date.parse(e.ts));
    expect([...tss].sort((a, b) => a - b)).toEqual(tss);
    expect(result.firstTs).toBe('2026-08-01T10:00:00.000Z');
  });
});

// ---- end-to-end import command tests ----

function makeClaudeDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-import-'));
  const projects = path.join(root, 'claude', 'projects');
  fs.mkdirSync(path.join(projects, '-home-richard-project-x'), { recursive: true });
  fs.mkdirSync(path.join(projects, '-home-richard-legacy'), { recursive: true });
  fs.writeFileSync(path.join(projects, '-home-richard-project-x', `${SID}.jsonl`), modernTranscript());
  fs.writeFileSync(path.join(projects, '-home-richard-legacy', 'bbbb0000.jsonl'), legacyTranscript('bbbb0000'));
  return path.join(root, 'claude');
}

describe('ccidle import (command)', () => {
  it('imports all sessions, is idempotent on re-run, and never writes under --claude-dir', async () => {
    const claudeDir = makeClaudeDir();
    const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-corpus-'));
    const linesOut: string[] = [];

    const before = fs.readdirSync(claudeDir, { recursive: true });
    const code = await runImport({ claudeDir, corpusDir: corpus, out: (l) => linesOut.push(l) });
    expect(code).toBe(0);
    expect(linesOut.join('\n')).toContain('2 session(s) imported');
    expect(fs.existsSync(path.join(corpus, `${SID}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(corpus, 'manifest.json'))).toBe(true);
    // read-only guarantee: nothing under claudeDir changed
    expect(fs.readdirSync(claudeDir, { recursive: true })).toEqual(before);

    // idempotent re-run: manifest hit, no reimport
    const rerun: string[] = [];
    const started = Date.now();
    const code2 = await runImport({ claudeDir, corpusDir: corpus, out: (l) => rerun.push(l) });
    expect(code2).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(rerun.join('\n')).toContain('0 session(s) imported, 2 unchanged');

    // changed source → reimported
    fs.appendFileSync(
      path.join(claudeDir, 'projects', '-home-richard-legacy', 'bbbb0000.jsonl'),
      line({
        type: 'assistant',
        timestamp: '2025-11-02T08:10:00.000Z',
        sessionId: 'bbbb0000',
        cwd: '/home/richard/legacy',
        uuid: 'la9',
        message: { model: 'm2', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }
      })
    );
    const rerun2: string[] = [];
    await runImport({ claudeDir, corpusDir: corpus, out: (l) => rerun2.push(l) });
    expect(rerun2.join('\n')).toContain('1 session(s) imported, 1 unchanged');
  });

  it('filters by --project and --since/--until', async () => {
    const claudeDir = makeClaudeDir();
    const corpusA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-corpus-'));
    const outA: string[] = [];
    await runImport({ claudeDir, corpusDir: corpusA, project: '*legacy*', out: (l) => outA.push(l) });
    expect(fs.existsSync(path.join(corpusA, 'bbbb0000.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(corpusA, `${SID}.jsonl`))).toBe(false);

    const corpusB = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-corpus-'));
    const outB: string[] = [];
    await runImport({ claudeDir, corpusDir: corpusB, since: '2026-01-01', out: (l) => outB.push(l) });
    expect(fs.existsSync(path.join(corpusB, `${SID}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(corpusB, 'bbbb0000.jsonl'))).toBe(false); // 2025 session filtered
    expect(outB.join('\n')).toContain('1 filtered out');
  });

  it('imported files replay through the native parser identically to live streams', async () => {
    const claudeDir = makeClaudeDir();
    const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-corpus-'));
    await runImport({ claudeDir, corpusDir: corpus, out: () => {} });
    const content = fs.readFileSync(path.join(corpus, `${SID}.jsonl`), 'utf8');
    const envelopes = content
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => parseEventLine(l));
    expect(envelopes.every((e): e is EventEnvelope => e !== null)).toBe(true);
  });
});

describe('project path helpers', () => {
  it('encodes cwd the way CC names project folders', () => {
    expect(encodeProjectPath('/home/user/cc-idle')).toBe('-home-user-cc-idle');
    expect(encodeProjectPath('/a/b.c_d')).toBe('-a-b-c-d');
  });

  it('matches by raw path, encoded name, or glob', () => {
    expect(projectMatches('-home-user-cc-idle', '/home/user/cc-idle')).toBe(true);
    expect(projectMatches('-home-user-cc-idle', '-home-user-cc-idle')).toBe(true);
    expect(projectMatches('-home-user-cc-idle', '*cc-idle')).toBe(true);
    expect(projectMatches('-home-user-cc-idle', '/home/user/other')).toBe(false);
  });

  it('discovers sessions with their subagent sidecars, sorted', () => {
    const claudeDir = makeClaudeDir();
    const sessionDir = path.join(claudeDir, 'projects', '-home-richard-project-x', SID, 'subagents');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'agent-b.jsonl'), '');
    fs.writeFileSync(path.join(sessionDir, 'agent-a.jsonl'), '');
    const sources = discoverSessions(claudeDir);
    expect(sources).toHaveLength(2);
    const withSub = sources.find((s) => s.mainPath.endsWith(`${SID}.jsonl`));
    expect(withSub?.subagentPaths.map((p) => path.basename(p))).toEqual(['agent-a.jsonl', 'agent-b.jsonl']);
  });
});
