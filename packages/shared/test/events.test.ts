import { describe, it, expect } from 'vitest';
import { parseEventLine, serializeEvent, EventEnvelopeSchema } from '../src/events.js';

describe('EventEnvelope', () => {
  const valid = {
    v: 1,
    ts: '2026-08-17T10:14:03.201Z',
    session_id: 'abc-123',
    event: 'PostToolUse',
    tool: 'Bash',
    cwd: '/path/to/repo',
    payload: { tool_name: 'Bash' }
  };

  it('parses a valid line', () => {
    const parsed = parseEventLine(JSON.stringify(valid));
    expect(parsed).not.toBeNull();
    expect(parsed!.event).toBe('PostToolUse');
    expect(parsed!.session_id).toBe('abc-123');
  });

  it('preserves unknown event names (CC version drift)', () => {
    const parsed = parseEventLine(JSON.stringify({ ...valid, event: 'SomeFutureEvent' }));
    expect(parsed).not.toBeNull();
    expect(parsed!.event).toBe('SomeFutureEvent');
  });

  it('preserves unknown envelope fields (passthrough)', () => {
    const parsed = parseEventLine(JSON.stringify({ ...valid, futureField: 'x' }));
    expect(parsed).not.toBeNull();
    expect((parsed as Record<string, unknown>).futureField).toBe('x');
  });

  it('returns null for blank lines and malformed JSON', () => {
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('   ')).toBeNull();
    expect(parseEventLine('{not json')).toBeNull();
  });

  it('returns null for schema mismatches', () => {
    expect(parseEventLine(JSON.stringify({ ...valid, v: 2 }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...valid, session_id: '' }))).toBeNull();
  });

  it('defaults payload to empty object', () => {
    const { payload: _payload, ...noPayload } = valid;
    const parsed = parseEventLine(JSON.stringify(noPayload));
    expect(parsed!.payload).toEqual({});
  });

  it('round-trips through serialize', () => {
    const envelope = EventEnvelopeSchema.parse(valid);
    const line = serializeEvent(envelope);
    expect(line.endsWith('\n')).toBe(true);
    expect(parseEventLine(line)).toEqual(envelope);
  });
});
