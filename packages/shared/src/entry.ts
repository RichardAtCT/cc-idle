import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` (pass `import.meta.url`) is the script
 * Node was started with. Compares real file paths, not a hand-built URL, so it
 * holds when the bin runs through a symlink (pnpm's .bin, npm link) or from a
 * path with spaces or other characters a file URL escapes.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}
