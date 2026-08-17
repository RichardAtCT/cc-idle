import { parseArgs } from 'node:util';
import { startDaemon, DAEMON_VERSION, DaemonAlreadyRunningError } from './daemon.js';

function printHelp(): void {
  process.stdout.write(`ccidled ${DAEMON_VERSION}

Usage: ccidled [options]

Options:
  --foreground   Run in the foreground (default; the launcher handles backgrounding)
  --version      Print the daemon version and exit
  --help         Show this help and exit
`);
}

/** `ccidled` bin entry. No daemonization magic — the launcher handles backgrounding. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      foreground: { type: 'boolean', default: true },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    strict: false
  });

  if (values.help) {
    printHelp();
    return;
  }
  if (values.version) {
    process.stdout.write(`${DAEMON_VERSION}\n`);
    return;
  }

  try {
    const handle = await startDaemon();
    handle.logger.info('ccidled started');
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`ccidled failed to start: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  void main();
}
