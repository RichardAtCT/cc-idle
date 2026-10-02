/**
 * Path globs for corpus hygiene filters.
 *
 * Deliberately small — enough to express the exclusion rules and nothing more:
 *   `**`  any run of characters, separators included
 *   `*`   any run of characters within one segment
 *   `?`   one character within one segment
 *
 * A leading `** /` and a trailing `/**` both match zero segments, so
 * `**​/scratchpad/**` excludes the scratchpad directory itself as well as
 * everything under it.
 */

function escapeLiteral(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function pathGlobToRegExp(glob: string): RegExp {
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    const rest = glob.slice(i);
    if (rest.startsWith('**/')) {
      pattern += '(?:.*/)?'; // matches zero or more leading segments
      i += 3;
      continue;
    }
    if (rest === '/**') {
      pattern += '(?:/.*)?'; // matches the directory itself or anything under it
      i += 3;
      continue;
    }
    if (rest.startsWith('**')) {
      pattern += '.*';
      i += 2;
      continue;
    }
    const char = glob[i]!;
    if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += escapeLiteral(char);
    i += 1;
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * The first glob that matches, or null. Returning the glob rather than a
 * boolean lets callers report which rule dropped a session, so filtering is
 * never silent.
 */
export function matchingGlob(value: string, globs: readonly string[]): string | null {
  for (const glob of globs) {
    if (glob === '') continue;
    try {
      if (pathGlobToRegExp(glob).test(value)) return glob;
    } catch {
      continue; // malformed glob excludes nothing rather than failing the run
    }
  }
  return null;
}
