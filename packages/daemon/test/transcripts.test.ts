import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEventLine, TokenUsagePayloadSchema } from '@ccidle/shared';
import { TranscriptReader, parseUsageDeltas } from '../src/transcripts.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-transcripts-'));
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function transcriptLine(model: string, usage: Record<string, number>): string {
  return JSON.stringify({ message: { model, usage } }) + '\n';
}

describe('parseUsageDeltas', () => {
  it('sums input/output/cache tokens per model across lines', () => {
    const content =
      transcriptLine('claude-opus-4', { input_tokens: 100, output_tokens: 20 }) +
      transcriptLine('claude-opus-4', {
        input_tokens: 5,
        output_tokens: 3,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10
      }) +
      transcriptLine('claude-haiku-4', { input_tokens: 1, output_tokens: 1 });

    const deltas = parseUsageDeltas(content);
    expect(deltas['claude-opus-4']).toEqual({
      inputTokens: 105,
      outputTokens: 23,
      cacheReadTokens: 40,
      cacheWriteTokens: 10
    });
    expect(deltas['claude-haiku-4']).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    });
  });

  it('skips lines with no message.usage or message.model', () => {
    const content = JSON.stringify({ message: { role: 'user' } }) + '\n' + '{not json\n' + '\n';
    expect(parseUsageDeltas(content)).toEqual({});
  });

  it('counts one response once although each content-block line repeats its usage', () => {
    const usage = { input_tokens: 10, output_tokens: 50 };
    const block = (uuid: string) =>
      JSON.stringify({ uuid, message: { id: 'msg_1', model: 'claude-opus-4', usage } }) + '\n';
    const deltas = parseUsageDeltas(block('a') + block('b') + block('c'));
    expect(deltas['claude-opus-4']).toEqual({
      inputTokens: 10,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    });
  });

  it('skips all-zero usage entries', () => {
    const content = transcriptLine('claude-opus-4', { input_tokens: 0, output_tokens: 0 });
    expect(parseUsageDeltas(content)).toEqual({});
  });
});

describe('TranscriptReader', () => {
  it('emits a synthetic TokenUsage envelope with only the new delta, appended to the event file', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const eventPath = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(eventPath, '');

    fs.writeFileSync(transcriptPath, transcriptLine('claude-opus-4', { input_tokens: 100, output_tokens: 10 }));

    const reader = new TranscriptReader();
    reader.setTranscriptPath('sess-1', transcriptPath);

    const envelope = reader.poll('sess-1', eventPath, '2026-08-17T10:00:00.000Z');
    expect(envelope).not.toBeNull();
    expect(envelope!.event).toBe('TokenUsage');
    expect(envelope!.payload.byModel).toEqual({
      'claude-opus-4': { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });

    const writtenLines = fs.readFileSync(eventPath, 'utf8').trim().split('\n');
    expect(writtenLines).toHaveLength(1);
    const parsed = parseEventLine(writtenLines[0]!);
    expect(parsed?.event).toBe('TokenUsage');

    // A second poll with no new transcript data yields nothing.
    expect(reader.poll('sess-1', eventPath, '2026-08-17T10:00:10.000Z')).toBeNull();

    // Append more transcript data — only the delta should show up next time.
    fs.appendFileSync(transcriptPath, transcriptLine('claude-opus-4', { input_tokens: 5, output_tokens: 2 }));
    const second = reader.poll('sess-1', eventPath, '2026-08-17T10:00:20.000Z');
    expect(second!.payload.byModel).toEqual({
      'claude-opus-4': { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });
  });

  it('does not recount a response whose lines straddle two polls', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const eventPath = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(eventPath, '');
    const block = JSON.stringify({
      message: { id: 'msg_1', model: 'claude-opus-4', usage: { input_tokens: 10, output_tokens: 50 } }
    }) + '\n';

    fs.writeFileSync(transcriptPath, block);
    const reader = new TranscriptReader();
    reader.setTranscriptPath('sess-1', transcriptPath);
    expect(reader.poll('sess-1', eventPath, '2026-08-17T10:00:00.000Z')).not.toBeNull();

    fs.appendFileSync(transcriptPath, block);
    expect(reader.poll('sess-1', eventPath, '2026-08-17T10:00:10.000Z')).toBeNull();
  });

  it('keeps the usage for the next poll when the TokenUsage append fails', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const eventPath = path.join(dir, 'events', 'sess-1.jsonl');
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ message: { id: 'msg_1', model: 'claude-opus-4', usage: { output_tokens: 7 } } }) + '\n'
    );
    const reader = new TranscriptReader();
    reader.setTranscriptPath('sess-1', transcriptPath);

    // The events dir does not exist yet, so the append throws.
    expect(reader.poll('sess-1', eventPath, '2026-08-17T10:00:00.000Z')).toBeNull();

    fs.mkdirSync(path.dirname(eventPath));
    const retry = reader.poll('sess-1', eventPath, '2026-08-17T10:00:10.000Z');
    expect(retry?.payload.byModel['claude-opus-4']?.outputTokens).toBe(7);
  });

  it('records where it stopped reading, and a new reader resumes there', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const eventPath = path.join(dir, 'sess-1.jsonl');
    const block = (id: string, out: number) =>
      JSON.stringify({ message: { id, model: 'claude-opus-4', usage: { output_tokens: out } } }) + '\n';
    fs.writeFileSync(transcriptPath, block('msg_1', 10));

    const first = new TranscriptReader();
    first.setTranscriptPath('sess-1', transcriptPath);
    const written = first.poll('sess-1', eventPath, '2026-08-17T10:00:00.000Z');
    expect(written?.payload).toMatchObject({
      transcriptPath,
      transcriptOffset: fs.statSync(transcriptPath).size,
      lastKey: 'msg_1'
    });

    // While no reader runs: a second line of msg_1 (same usage) and a new response.
    fs.appendFileSync(transcriptPath, block('msg_1', 10) + block('msg_2', 3));

    const restarted = new TranscriptReader();
    restarted.setTranscriptPath('sess-1', transcriptPath);
    restarted.resume('sess-1', TokenUsagePayloadSchema.parse(parseEventLine(fs.readFileSync(eventPath, 'utf8'))!.payload));
    restarted.finishReplay();
    const next = restarted.poll('sess-1', eventPath, '2026-08-17T10:01:00.000Z');
    expect(next?.payload.byModel['claude-opus-4']?.outputTokens).toBe(3);
  });

  it('skips to the transcript end after replaying a TokenUsage that has no offset', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const eventPath = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLine('claude-opus-4', { output_tokens: 10 }));

    const reader = new TranscriptReader();
    reader.setTranscriptPath('sess-1', transcriptPath);
    reader.resume('sess-1', { byModel: {} });
    reader.finishReplay();
    expect(reader.poll('sess-1', eventPath, '2026-08-17T10:00:00.000Z')).toBeNull();

    // With no TokenUsage replayed, nothing was counted yet: start at the top.
    const fresh = new TranscriptReader();
    fresh.setTranscriptPath('sess-1', transcriptPath);
    fresh.finishReplay();
    expect(fresh.poll('sess-1', eventPath, '2026-08-17T10:00:00.000Z')).not.toBeNull();
  });

  it('tolerates a missing or unreadable transcript file silently', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const eventPath = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(eventPath, '');

    const reader = new TranscriptReader();
    reader.setTranscriptPath('sess-1', path.join(dir, 'does-not-exist.jsonl'));
    expect(() => reader.poll('sess-1', eventPath, '2026-08-17T10:00:00.000Z')).not.toThrow();
    expect(reader.poll('sess-1', eventPath, '2026-08-17T10:00:00.000Z')).toBeNull();
  });

  it('returns null and does nothing for sessions with no tracked transcript', () => {
    const reader = new TranscriptReader();
    expect(reader.hasTranscript('sess-x')).toBe(false);
    expect(reader.poll('sess-x', '/tmp/nope.jsonl', '2026-08-17T10:00:00.000Z')).toBeNull();
  });

  it('throttles polling via shouldPoll/markPolled', () => {
    const reader = new TranscriptReader();
    expect(reader.shouldPoll('sess-1', 1000, 10_000)).toBe(true);
    reader.markPolled('sess-1', 1000);
    expect(reader.shouldPoll('sess-1', 5000, 10_000)).toBe(false);
    expect(reader.shouldPoll('sess-1', 11_001, 10_000)).toBe(true);
  });
});
