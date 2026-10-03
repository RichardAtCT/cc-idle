import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../src/entry.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tmpScript(dirName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirName));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'cli.js');
  fs.writeFileSync(script, '');
  return script;
}

describe('isEntryPoint', () => {
  it('matches the script itself', () => {
    const script = tmpScript('ccidle-entry-');
    expect(isEntryPoint(pathToFileURL(script).href, script)).toBe(true);
  });

  it('matches through a symlink, as pnpm .bin runs it', () => {
    const script = tmpScript('ccidle-entry-');
    const link = path.join(path.dirname(script), 'ccidle');
    fs.symlinkSync(script, link);
    expect(isEntryPoint(pathToFileURL(script).href, link)).toBe(true);
  });

  it('matches a path with spaces, which a file URL escapes', () => {
    const script = tmpScript('ccidle entry ');
    expect(isEntryPoint(pathToFileURL(script).href, script)).toBe(true);
  });

  it('rejects another script or a missing argv[1]', () => {
    const script = tmpScript('ccidle-entry-');
    const other = tmpScript('ccidle-entry-');
    expect(isEntryPoint(pathToFileURL(script).href, other)).toBe(false);
    expect(isEntryPoint(pathToFileURL(script).href, undefined)).toBe(false);
  });
});
