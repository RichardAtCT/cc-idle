import { describe, it, expect } from 'vitest';
import { matchingGlob, pathGlobToRegExp } from '../src/glob.js';
import { distinguishingNames } from '../src/names.js';

describe('pathGlobToRegExp', () => {
  it('matches a directory and everything under it with a trailing /**', () => {
    const re = pathGlobToRegExp('/private/tmp/**');
    expect(re.test('/private/tmp')).toBe(true);
    expect(re.test('/private/tmp/harness')).toBe(true);
    expect(re.test('/private/tmp/a/b/c')).toBe(true);
    expect(re.test('/private/tmpfoo')).toBe(false);
    expect(re.test('/Users/rich/private/tmp')).toBe(false);
  });

  it('matches at any depth with a leading **/', () => {
    const re = pathGlobToRegExp('**/scratchpad/**');
    expect(re.test('scratchpad')).toBe(true);
    expect(re.test('/a/b/scratchpad')).toBe(true);
    expect(re.test('/a/b/scratchpad/c/d')).toBe(true);
    expect(re.test('/a/b/scratchpads')).toBe(false);
    expect(re.test('/a/scratchpad-old/c')).toBe(false);
  });

  it('keeps a single * inside one segment', () => {
    const re = pathGlobToRegExp('/Users/*/projects');
    expect(re.test('/Users/rich/projects')).toBe(true);
    expect(re.test('/Users/rich/deep/projects')).toBe(false);
  });

  it('treats ? as exactly one non-separator character', () => {
    const re = pathGlobToRegExp('/tmp/run-?');
    expect(re.test('/tmp/run-1')).toBe(true);
    expect(re.test('/tmp/run-12')).toBe(false);
    expect(re.test('/tmp/run-/')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const re = pathGlobToRegExp('/tmp/a.b+c');
    expect(re.test('/tmp/a.b+c')).toBe(true);
    expect(re.test('/tmp/axbxc')).toBe(false);
  });
});

describe('matchingGlob', () => {
  const rules = ['/private/tmp/**', '**/scratchpad/**'];

  it('returns the rule that matched, so filtering can be explained', () => {
    expect(matchingGlob('/private/tmp/x', rules)).toBe('/private/tmp/**');
    expect(matchingGlob('/home/me/scratchpad/x', rules)).toBe('**/scratchpad/**');
  });

  it('returns null when nothing matches', () => {
    expect(matchingGlob('/Users/rich/projects/cc-idle', rules)).toBeNull();
  });

  it('ignores empty rules, so --exclude "" excludes nothing', () => {
    expect(matchingGlob('/private/tmp/x', [''])).toBeNull();
    expect(matchingGlob('/anything', [])).toBeNull();
  });
});

describe('distinguishingNames', () => {
  it('keeps a bare leaf when it is already unique', () => {
    const names = distinguishingNames(['/a/b/cc-idle', '/a/b/willz']);
    expect(names.get('/a/b/cc-idle')).toBe('cc-idle');
    expect(names.get('/a/b/willz')).toBe('willz');
  });

  it('extends colliding leaves by the shortest distinguishing suffix', () => {
    const names = distinguishingNames(['/tmp/01-bugfix/opus', '/tmp/03-refactor/opus']);
    expect(names.get('/tmp/01-bugfix/opus')).toBe('01-bugfix/opus');
    expect(names.get('/tmp/03-refactor/opus')).toBe('03-refactor/opus');
  });

  it('extends only as far as it must', () => {
    const names = distinguishingNames(['/x/y/a/opus', '/x/z/b/opus', '/q/solo']);
    expect(names.get('/x/y/a/opus')).toBe('a/opus');
    expect(names.get('/x/z/b/opus')).toBe('b/opus');
    expect(names.get('/q/solo')).toBe('solo');
  });

  it('falls back to the full path when no suffix distinguishes it', () => {
    const names = distinguishingNames(['/a/b/opus', '/b/opus']);
    expect(names.get('/b/opus')).toBe('/b/opus');
    expect(names.get('/a/b/opus')).toBe('a/b/opus');
  });

  it('handles duplicates and degenerate paths without throwing', () => {
    const names = distinguishingNames(['/a/b', '/a/b', '/', '']);
    expect(names.get('/a/b')).toBe('b');
    expect(names.get('/')).toBe('/');
    expect(names.get('')).toBe('');
  });
});
