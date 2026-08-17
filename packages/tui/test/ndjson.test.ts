import { describe, it, expect } from 'vitest';
import { NdjsonLineBuffer } from '../src/client.js';

describe('NdjsonLineBuffer', () => {
  it('returns nothing until a newline arrives', () => {
    const buffer = new NdjsonLineBuffer();
    expect(buffer.push('{"type":"status"')).toEqual([]);
    expect(buffer.buffered).toBe('{"type":"status"');
  });

  it('splits a single complete line', () => {
    const buffer = new NdjsonLineBuffer();
    expect(buffer.push('{"a":1}\n')).toEqual(['{"a":1}']);
    expect(buffer.buffered).toBe('');
  });

  it('handles multiple messages arriving in one chunk', () => {
    const buffer = new NdjsonLineBuffer();
    const lines = buffer.push('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
  });

  it('reassembles a line split across chunks', () => {
    const buffer = new NdjsonLineBuffer();
    expect(buffer.push('{"a":')).toEqual([]);
    expect(buffer.push('1}\n')).toEqual(['{"a":1}']);
  });

  it('handles a chunk containing a partial line after complete ones', () => {
    const buffer = new NdjsonLineBuffer();
    const lines = buffer.push('{"a":1}\n{"a":2}\n{"partial":');
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(buffer.buffered).toBe('{"partial":');
    expect(buffer.push('"done"}\n')).toEqual(['{"partial":"done"}']);
  });

  it('handles many small fragments of one line', () => {
    const buffer = new NdjsonLineBuffer();
    const text = '{"hello":"world"}\n';
    let lines: string[] = [];
    for (const char of text) {
      lines = lines.concat(buffer.push(char));
    }
    expect(lines).toEqual(['{"hello":"world"}']);
  });

  it('treats an empty chunk as a no-op', () => {
    const buffer = new NdjsonLineBuffer();
    expect(buffer.push('')).toEqual([]);
    expect(buffer.push('{"a":1}\n')).toEqual(['{"a":1}']);
  });

  it('handles back-to-back newlines as an empty line between messages', () => {
    const buffer = new NdjsonLineBuffer();
    const lines = buffer.push('{"a":1}\n\n{"a":2}\n');
    expect(lines).toEqual(['{"a":1}', '', '{"a":2}']);
  });
});
