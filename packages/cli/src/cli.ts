#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runInstall, runUninstall } from './installer.js';
import { runDoctor, formatDoctorReport, doctorExitCode } from './doctor.js';
import { sendRegister } from './register.js';
import { runUp } from './up.js';
import { runAttach } from './attach.js';

function printHelp(): void {
  console.log(`ccidle — CC Idle launcher & hook installer

Usage:
  ccidle install [--settings <path>] [--dry-run]
  ccidle uninstall [--settings <path>]
  ccidle doctor [--fire-test-event] [--strict] [--settings <path>]
  ccidle register --role cc|game [--pane <id>] [--cwd <dir>] [--session <id>]
  ccidle up [--no-claude]
  ccidle attach [--cwd <dir>]
`);
}

export async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case 'install': {
      const { values } = parseArgs({
        args: rest,
        options: {
          settings: { type: 'string' },
          'dry-run': { type: 'boolean', default: false }
        }
      });
      runInstall({ settingsPath: values.settings as string | undefined, dryRun: values['dry-run'] as boolean });
      return 0;
    }

    case 'uninstall': {
      const { values } = parseArgs({
        args: rest,
        options: { settings: { type: 'string' } }
      });
      runUninstall({ settingsPath: values.settings as string | undefined });
      return 0;
    }

    case 'doctor': {
      const { values } = parseArgs({
        args: rest,
        options: {
          'fire-test-event': { type: 'boolean', default: false },
          strict: { type: 'boolean', default: false },
          settings: { type: 'string' }
        }
      });
      const report = await runDoctor({
        settingsPath: values.settings as string | undefined,
        fireTestEvent: values['fire-test-event'] as boolean
      });
      console.log(formatDoctorReport(report));
      return doctorExitCode(report, values.strict as boolean);
    }

    case 'register': {
      const { values } = parseArgs({
        args: rest,
        options: {
          role: { type: 'string' },
          pane: { type: 'string' },
          cwd: { type: 'string' },
          session: { type: 'string' }
        }
      });
      const role = values.role;
      if (role !== 'cc' && role !== 'game') {
        console.error('ccidle register: --role must be "cc" or "game"');
        return 1;
      }
      const result = await sendRegister({
        role,
        pane: values.pane as string | undefined,
        cwd: values.cwd as string | undefined,
        sessionId: values.session as string | undefined
      });
      console.log(result.detail);
      return result.connected ? 0 : 1;
    }

    case 'up': {
      const { values } = parseArgs({
        args: rest,
        options: { 'no-claude': { type: 'boolean', default: false } }
      });
      await runUp({ noClaude: values['no-claude'] as boolean });
      return 0;
    }

    case 'attach': {
      const { values } = parseArgs({
        args: rest,
        options: { cwd: { type: 'string' } }
      });
      await runAttach({ cwd: values.cwd as string | undefined });
      return 0;
    }

    case '-h':
    case '--help':
    case 'help':
      printHelp();
      return 0;

    case undefined:
      printHelp();
      return 1;

    default:
      console.error(`ccidle: unknown command "${sub}"`);
      printHelp();
      return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`ccidle: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
