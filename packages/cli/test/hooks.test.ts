import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEnvelopeSchema, parseEventLine } from '@ccidle/shared';

// packages/cli/test -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');

const WRAPPERS: Record<string, string> = {
  SessionStart: 'on-session-start.sh',
  SessionEnd: 'on-session-end.sh',
  UserPromptSubmit: 'on-user-prompt-submit.sh',
  PreToolUse: 'on-pre-tool-use.sh',
  PostToolUse: 'on-post-tool-use.sh',
  Stop: 'on-stop.sh',
  SubagentStop: 'on-subagent-stop.sh',
  Notification: 'on-notification.sh'
};

function runHook(
  script: string,
  input: unknown,
  env: NodeJS.ProcessEnv
): { status: number | null; stdout: string; stderr: string } {
  const scriptPath = path.join(HOOKS_DIR, script);
  const result = spawnSync(scriptPath, [], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env,
    encoding: 'utf8',
    timeout: 5000
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readSessionLines(ccidleHome: string, sessionId: string): string[] {
  const file = path.join(ccidleHome, 'events', `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/**
 * A directory on PATH containing only the coreutils the shim needs, minus jq
 * — used to exercise the shell-only fallback path deterministically, without
 * assuming jq lives in any particular system directory.
 */
function buildNoJqPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-nojq-bin-'));
  for (const tool of ['sh', 'cat', 'date', 'sed', 'mkdir', 'tr', 'head', 'printf', 'dirname']) {
    const real = findRealBin(tool);
    if (real) fs.symlinkSync(real, path.join(dir, tool));
  }
  return dir;
}

function findRealBin(tool: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const d of dirs) {
    const candidate = path.join(d, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

describe('hook shims (integration, real child processes)', () => {
  let ccidleHome: string;
  let baseEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    ccidleHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-hooktest-'));
    baseEnv = { ...process.env, CCIDLE_HOME: ccidleHome, TMUX_PANE: '' };
  });

  afterEach(() => {
    fs.rmSync(ccidleHome, { recursive: true, force: true });
  });

  it.each(Object.entries(WRAPPERS))(
    'produces a valid v1 envelope for %s and exits 0 with empty stdout',
    (eventName, script) => {
      const sessionId = `sess-${eventName.toLowerCase()}`;
      const fixture = {
        session_id: sessionId,
        transcript_path: `/home/user/.claude/projects/x/${sessionId}.jsonl`,
        cwd: '/home/user/project',
        hook_event_name: eventName,
        tool_name: eventName.includes('ToolUse') ? 'Bash' : undefined,
        tool_input: eventName.includes('ToolUse') ? { command: 'echo hi' } : undefined,
        tool_response: eventName === 'PostToolUse' ? { output: 'hi\n' } : undefined,
        message: eventName === 'UserPromptSubmit' ? 'do the thing' : undefined,
        model: eventName === 'SessionStart' ? 'claude-opus-4' : undefined
      };

      const { status, stdout, stderr } = runHook(script, fixture, baseEnv);

      expect(stdout).toBe('');
      expect(status).toBe(0);

      const lines = readSessionLines(ccidleHome, sessionId);
      expect(lines).toHaveLength(1);

      const parsed = EventEnvelopeSchema.parse(JSON.parse(lines[0]!));
      expect(parsed.v).toBe(1);
      expect(parsed.session_id).toBe(sessionId);
      expect(parsed.event).toBe(eventName);
      expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      if (fixture.tool_name) expect(parsed.tool).toBe('Bash');
      expect(parsed.cwd).toBe('/home/user/project');

      if (stderr.trim() !== '') {
        // shims must never write to stderr either, in normal operation
        throw new Error(`unexpected stderr from ${script}: ${stderr}`);
      }
    }
  );

  it('logs a genuinely unknown event name end-to-end (never dropped, per PRD §7)', () => {
    const sessionId = 'sess-future-event';
    const scriptPath = path.join(HOOKS_DIR, 'ccidle-hook.sh');
    const result = spawnSync(scriptPath, ['SomeFutureEvent'], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: 'SomeFutureEvent' }),
      env: baseEnv,
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const lines = readSessionLines(ccidleHome, sessionId);
    expect(lines).toHaveLength(1);
    const parsed = parseEventLine(lines[0]!);
    expect(parsed?.event).toBe('SomeFutureEvent');
  });

  it('never crashes on malformed JSON input, still logging an envelope', () => {
    const { status, stdout } = runHook('on-stop.sh', 'not json at all {{{', baseEnv);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    const lines = readSessionLines(ccidleHome, 'unknown');
    expect(lines).toHaveLength(1);
    const parsed = EventEnvelopeSchema.parse(JSON.parse(lines[0]!));
    expect(parsed.session_id).toBe('unknown');
    expect(parsed.payload).toEqual({ raw_unavailable: true });
  });

  it('truncates oversized payloads to a {truncated:true} summary rather than embedding raw bytes', () => {
    const sessionId = 'sess-big-payload';
    const fixture = {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'x'.repeat(6000) }
    };
    const { status } = runHook('on-pre-tool-use.sh', fixture, baseEnv);
    expect(status).toBe(0);
    const lines = readSessionLines(ccidleHome, sessionId);
    const parsed = EventEnvelopeSchema.parse(JSON.parse(lines[0]!));
    expect(parsed.payload).toMatchObject({ truncated: true, tool_name: 'Bash' });
  });

  it('never writes to stdout even for a very chatty tool_response', () => {
    const fixture = {
      session_id: 'sess-chatty',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { output: 'line\n'.repeat(500) }
    };
    const { stdout, status } = runHook('on-post-tool-use.sh', fixture, baseEnv);
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  describe('no-jq fallback', () => {
    it('still records session_id and a valid envelope when jq is unavailable on PATH', () => {
      const noJqPath = buildNoJqPath();
      try {
        const sessionId = 'sess-nojq';
        const env = { ...baseEnv, PATH: noJqPath };
        const { status, stdout } = runHook('on-stop.sh', { session_id: sessionId, hook_event_name: 'Stop' }, env);
        expect(status).toBe(0);
        expect(stdout).toBe('');
        const lines = readSessionLines(ccidleHome, sessionId);
        expect(lines).toHaveLength(1);
        const parsed = EventEnvelopeSchema.parse(JSON.parse(lines[0]!));
        expect(parsed.session_id).toBe(sessionId);
        expect(parsed.event).toBe('Stop');
        expect(parsed.payload).toEqual({ raw_unavailable: true });
      } finally {
        fs.rmSync(noJqPath, { recursive: true, force: true });
      }
    });
  });

  describe('redact.sed application', () => {
    it('redacts a matching secret pattern out of the embedded payload', () => {
      fs.writeFileSync(
        path.join(ccidleHome, 'redact.sed'),
        's/sk-[A-Za-z0-9-]{10,}/[REDACTED]/g\n'
      );
      const sessionId = 'sess-redact';
      const fixture = {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { env: { API_KEY: 'sk-abcdefghijklmnop' } }
      };
      const { status } = runHook('on-pre-tool-use.sh', fixture, baseEnv);
      expect(status).toBe(0);

      const lines = readSessionLines(ccidleHome, sessionId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('sk-abcdefghijklmnop');
      expect(lines[0]).toContain('[REDACTED]');

      const parsed = EventEnvelopeSchema.parse(JSON.parse(lines[0]!));
      expect((parsed.payload as any).tool_input.env.API_KEY).toBe('[REDACTED]');
    });

    it('leaves payloads with no matching secret untouched', () => {
      fs.writeFileSync(
        path.join(ccidleHome, 'redact.sed'),
        's/sk-[A-Za-z0-9-]{10,}/[REDACTED]/g\n'
      );
      const sessionId = 'sess-no-secret';
      const { status } = runHook(
        'on-pre-tool-use.sh',
        { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
        baseEnv
      );
      expect(status).toBe(0);
      const lines = readSessionLines(ccidleHome, sessionId);
      const parsed = EventEnvelopeSchema.parse(JSON.parse(lines[0]!));
      expect((parsed.payload as any).tool_input.command).toBe('ls');
    });
  });

  describe('TMUX_PANE propagation', () => {
    it('embeds $TMUX_PANE as the pane field when set', () => {
      const sessionId = 'sess-pane';
      const env = { ...baseEnv, TMUX_PANE: '%3' };
      runHook('on-pre-tool-use.sh', { session_id: sessionId, hook_event_name: 'PreToolUse' }, env);
      const lines = readSessionLines(ccidleHome, sessionId);
      const parsed = EventEnvelopeSchema.parse(JSON.parse(lines[0]!));
      expect(parsed.pane).toBe('%3');
    });

    it('omits pane when $TMUX_PANE is empty', () => {
      const sessionId = 'sess-no-pane';
      runHook('on-pre-tool-use.sh', { session_id: sessionId, hook_event_name: 'PreToolUse' }, baseEnv);
      const lines = readSessionLines(ccidleHome, sessionId);
      const parsed = EventEnvelopeSchema.parse(JSON.parse(lines[0]!));
      expect(parsed.pane).toBeUndefined();
    });
  });

  describe('performance', () => {
    it('reports measured shim latency (informational; PRD budget is <10ms)', () => {
      const sessionId = 'sess-perf';
      const fixture = { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash' };
      const scriptPath = path.join(HOOKS_DIR, 'on-pre-tool-use.sh');
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = process.hrtime.bigint();
        spawnSync(scriptPath, [], { input: JSON.stringify(fixture), env: baseEnv, encoding: 'utf8' });
        samples.push(Number(process.hrtime.bigint() - start) / 1_000_000);
      }
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      console.log(`[hook shim latency] samples(ms)=${samples.map((s) => s.toFixed(2)).join(',')} avg=${avg.toFixed(2)}`);
      expect(avg).toBeGreaterThan(0);
    });
  });
});
