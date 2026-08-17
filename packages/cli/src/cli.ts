#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runInstall, runUninstall } from './installer.js';
import { runDoctor, formatDoctorReport, doctorExitCode } from './doctor.js';
import { sendRegister } from './register.js';
import { runUp } from './up.js';
import { runAttach } from './attach.js';
import { runReplay } from './replay.js';
import { runImport } from './import.js';
import { runBacktest } from './backtest.js';
import { runCorpusSnapshot } from './corpus.js';

function printHelp(): void {
  console.log(`ccidle — CC Idle launcher & hook installer

Usage:
  ccidle install [--settings <path>] [--dry-run]
  ccidle uninstall [--settings <path>]
  ccidle doctor [--fire-test-event] [--strict] [--settings <path>]
  ccidle register --role cc|game [--pane <id>] [--cwd <dir>] [--session <id>]
  ccidle up [--no-claude]
  ccidle attach [--cwd <dir>]
  ccidle replay <session.jsonl>... [--speed <x>] [--json] [--quiet]
  ccidle import [--claude-dir <dir>] [--project <path|glob>] [--since <date>] [--until <date>] [--corpus-dir <dir>] [--exclude <glob>]... [--no-default-excludes]
  ccidle backtest [file...] [--corpus-dir <dir>] [--json] [--md-out <path>] [--json-out <path>] [--exclude <glob>]... [--no-default-excludes] [--min-turns <n>]

Corpus hygiene:
  --exclude <glob>         drop sessions whose working directory matches; repeatable.
                           Replaces the config defaults (${'/private/tmp/**'}, ${'**/scratchpad/**'}).
  --no-default-excludes    keep every session, same as --exclude ''.
  --min-turns <n>          backtest only: drop sessions with fewer than n turns.
  ccidle corpus snapshot [--claude-dir <dir>] [--date <YYYY-MM-DD>]
`);
}

/**
 * Resolves exclusion globs from the command line. Any explicit --exclude
 * replaces the config defaults rather than adding to them, so `--exclude ''`
 * and --no-default-excludes both mean "exclude nothing"; omitting the flag
 * entirely leaves the config defaults in force.
 */
function resolveExcludes(exclude: string[] | undefined, noDefaults: boolean): string[] | undefined {
  if (noDefaults) return [];
  if (exclude === undefined) return undefined;
  return exclude.filter((g) => g !== '');
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

    case 'replay': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          speed: { type: 'string' },
          json: { type: 'boolean', default: false },
          quiet: { type: 'boolean', default: false }
        }
      });
      if (positionals.length === 0) {
        console.error('ccidle replay: at least one event file is required');
        return 1;
      }
      let speed: number | undefined;
      if (values.speed !== undefined) {
        speed = Number(values.speed);
        if (!Number.isFinite(speed) || speed <= 0) {
          console.error('ccidle replay: --speed must be a positive number');
          return 1;
        }
      }
      return runReplay({
        files: positionals,
        speed,
        json: values.json as boolean,
        quiet: values.quiet as boolean
      });
    }

    case 'import': {
      const { values } = parseArgs({
        args: rest,
        options: {
          'claude-dir': { type: 'string' },
          'corpus-dir': { type: 'string' },
          project: { type: 'string' },
          since: { type: 'string' },
          until: { type: 'string' },
          exclude: { type: 'string', multiple: true },
          'no-default-excludes': { type: 'boolean', default: false }
        }
      });
      return runImport({
        claudeDir: values['claude-dir'] as string | undefined,
        corpusDir: values['corpus-dir'] as string | undefined,
        project: values.project as string | undefined,
        since: values.since as string | undefined,
        until: values.until as string | undefined,
        exclude: resolveExcludes(values.exclude as string[] | undefined, values['no-default-excludes'] as boolean)
      });
    }

    case 'backtest': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          'corpus-dir': { type: 'string' },
          json: { type: 'boolean', default: false },
          'md-out': { type: 'string' },
          'json-out': { type: 'string' },
          exclude: { type: 'string', multiple: true },
          'no-default-excludes': { type: 'boolean', default: false },
          'min-turns': { type: 'string' }
        }
      });
      const minTurnsRaw = values['min-turns'] as string | undefined;
      const minTurns = minTurnsRaw === undefined ? undefined : Number(minTurnsRaw);
      if (minTurns !== undefined && (!Number.isInteger(minTurns) || minTurns < 0)) {
        console.error(`ccidle backtest: --min-turns must be a non-negative integer, got "${minTurnsRaw}"`);
        return 1;
      }
      return runBacktest({
        files: positionals,
        corpusDir: values['corpus-dir'] as string | undefined,
        json: values.json as boolean,
        mdOut: values['md-out'] as string | undefined,
        jsonOut: values['json-out'] as string | undefined,
        exclude: resolveExcludes(values.exclude as string[] | undefined, values['no-default-excludes'] as boolean),
        minTurns
      });
    }

    case 'corpus': {
      const [action, ...corpusRest] = rest;
      if (action !== 'snapshot') {
        console.error('ccidle corpus: only "snapshot" is supported (ccidle corpus snapshot)');
        return 1;
      }
      const { values } = parseArgs({
        args: corpusRest,
        options: {
          'claude-dir': { type: 'string' },
          date: { type: 'string' }
        }
      });
      return runCorpusSnapshot({
        claudeDir: values['claude-dir'] as string | undefined,
        date: values.date as string | undefined
      });
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
