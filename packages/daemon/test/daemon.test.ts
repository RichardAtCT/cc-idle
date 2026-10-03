import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDirs, eventFilePath, parseEventLine, TokenUsagePayloadSchema } from '@ccidle/shared';
import { startDaemon } from '../src/daemon.js';
import { FakeTmuxClient } from '../src/tmux.js';
import { RegistrationStore } from '../src/registrations.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tmpHome(): NodeJS.ProcessEnv {
  // os.tmpdir(), not a deep scratch path: macOS caps unix socket paths at 104 bytes.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-daemon-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, CCIDLE_HOME: home };
  ensureDirs(env);
  return env;
}

function eventLine(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, ts: new Date().toISOString(), session_id: 's1', event, ...extra }) + '\n';
}

function usageLine(id: string, outputTokens: number): string {
  return JSON.stringify({ message: { id, model: 'claude-opus-4', usage: { output_tokens: outputTokens } } }) + '\n';
}

/** Every TokenUsage in the session's event file, as output-token counts. */
function tokenUsageCounts(env: NodeJS.ProcessEnv): number[] {
  return fs
    .readFileSync(eventFilePath('s1', env), 'utf8')
    .split('\n')
    .map((line) => parseEventLine(line))
    .filter((e) => e?.event === 'TokenUsage')
    .map((e) => TokenUsagePayloadSchema.parse(e!.payload).byModel['claude-opus-4']?.outputTokens ?? 0);
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runOnce(env: NodeJS.ProcessEnv, tmux = new FakeTmuxClient()): Promise<FakeTmuxClient> {
  const daemon = await startDaemon(env, { tmux });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await daemon.stop();
  return tmux;
}

describe('startDaemon replay', () => {
  it('counts transcript usage once across restarts, and counts usage added later', async () => {
    const env = tmpHome();
    const transcript = path.join(env.CCIDLE_HOME!, 'transcript.jsonl');
    fs.writeFileSync(transcript, usageLine('msg_1', 100));
    const payload = { transcript_path: transcript };
    fs.writeFileSync(
      eventFilePath('s1', env),
      eventLine('SessionStart', { payload }) + eventLine('UserPromptSubmit', { payload }) + eventLine('Stop', { payload })
    );

    // The Stop is only in the replayed log, so no run should read the transcript for it.
    for (let run = 0; run < 3; run++) await runOnce(env);
    expect(tokenUsageCounts(env)).toEqual([]);

    // A live turn counts the whole transcript once.
    const daemon = await startDaemon(env, { tmux: new FakeTmuxClient() });
    fs.appendFileSync(eventFilePath('s1', env), eventLine('UserPromptSubmit', { payload }) + eventLine('Stop', { payload }));
    await waitFor(() => tokenUsageCounts(env).length === 1);
    await daemon.stop();
    expect(tokenUsageCounts(env)).toEqual([100]);

    // Usage written while the daemon is down is counted at the next live Stop, and only that usage.
    fs.appendFileSync(transcript, usageLine('msg_2', 5));
    await runOnce(env);
    const again = await startDaemon(env, { tmux: new FakeTmuxClient() });
    fs.appendFileSync(eventFilePath('s1', env), eventLine('UserPromptSubmit', { payload }) + eventLine('Stop', { payload }));
    await waitFor(() => tokenUsageCounts(env).length === 2);
    await again.stop();
    await runOnce(env);
    expect(tokenUsageCounts(env)).toEqual([100, 5]);
  });

  it('does not move tmux focus for replayed events', async () => {
    const env = tmpHome();
    new RegistrationStore(env).setGamePane('%2');
    const tmux = new FakeTmuxClient();
    tmux.panes.set('%1', 'work:0.0');
    tmux.panes.set('%2', 'game:0.0');
    tmux.currentTarget = 'game:0.0';
    // In the log: Claude finished a turn in pane %1 while the user sat in the game pane.
    fs.writeFileSync(
      eventFilePath('s1', env),
      eventLine('SessionStart', { pane: '%1' }) + eventLine('UserPromptSubmit', { pane: '%1' }) + eventLine('Stop', { pane: '%1' })
    );

    await runOnce(env, tmux);
    expect(tmux.focusCalls).toEqual([]);
  });
});
