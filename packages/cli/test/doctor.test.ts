import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countSessionFiles, doctorExitCode, findOnPath, runDoctor, type DoctorReport } from '../src/doctor.js';
import { runInstall } from '../src/installer.js';

describe('countSessionFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-doctor-events-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('counts *.jsonl but excludes *.archive.jsonl and returns 0 for a missing dir', () => {
    expect(countSessionFiles(path.join(dir, 'nope'))).toBe(0);
    fs.writeFileSync(path.join(dir, 'sess-a.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'sess-b.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'sess-a.archive.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    expect(countSessionFiles(dir)).toBe(2);
  });
});

describe('findOnPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-doctor-path-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds an executable placed on PATH', () => {
    const bin = path.join(dir, 'my-tool');
    fs.writeFileSync(bin, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    const found = findOnPath('my-tool', { PATH: dir });
    expect(found).toBe(bin);
  });

  it('returns null when nothing on PATH matches', () => {
    expect(findOnPath('definitely-not-a-real-binary-xyz', { PATH: dir })).toBeNull();
  });

  it('handles an empty/missing PATH without throwing', () => {
    expect(findOnPath('jq', {})).toBeNull();
  });
});

describe('doctorExitCode', () => {
  const okReport: DoctorReport = { checks: [{ name: 'a', status: 'ok', detail: '' }] };
  const critReport: DoctorReport = {
    checks: [
      { name: 'a', status: 'ok', detail: '' },
      { name: 'b', status: 'crit', detail: '' }
    ]
  };

  it('is always 0 when --strict is not set, regardless of findings', () => {
    expect(doctorExitCode(okReport, false)).toBe(0);
    expect(doctorExitCode(critReport, false)).toBe(0);
  });

  it('is 0 under --strict when nothing critical was found', () => {
    expect(doctorExitCode(okReport, true)).toBe(0);
  });

  it('is nonzero under --strict when a critical check failed', () => {
    expect(doctorExitCode(critReport, true)).toBe(1);
  });

  it('a failed fire-test-event counts as critical under --strict', () => {
    const report: DoctorReport = {
      checks: [{ name: 'a', status: 'ok', detail: '' }],
      fireTestEvent: { ranOk: false, latencyMs: 1, detail: 'nope' }
    };
    expect(doctorExitCode(report, true)).toBe(1);
  });
});

describe('runDoctor settings-inspection integration', () => {
  let dir: string;
  let settingsPath: string;
  let hooksDirOverride: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-doctor-run-'));
    settingsPath = path.join(dir, 'settings.json');
    hooksDirOverride = path.join(dir, 'hooks');
    process.env.CCIDLE_HOME = path.join(dir, 'ccidle-home');
  });

  afterEach(() => {
    delete process.env.CCIDLE_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports hooks-installed as crit when settings.json has no ccidle hooks', async () => {
    fs.writeFileSync(settingsPath, '{}');
    const report = await runDoctor({ settingsPath });
    const check = report.checks.find((c) => c.name === 'hooks-installed');
    expect(check?.status).toBe('crit');
  });

  it('reports hooks-installed as ok after a real install', async () => {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      runInstall({ settingsPath, hooksDirOverride });
    } finally {
      console.log = originalLog;
    }
    const report = await runDoctor({ settingsPath });
    const check = report.checks.find((c) => c.name === 'hooks-installed');
    expect(check?.status).toBe('ok');
  });

  it('reports the daemon as not running when no pidfile exists', async () => {
    fs.writeFileSync(settingsPath, '{}');
    const report = await runDoctor({ settingsPath });
    const check = report.checks.find((c) => c.name === 'daemon');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('not running');
  });

  it('always includes a node check reporting the current process version', async () => {
    fs.writeFileSync(settingsPath, '{}');
    const report = await runDoctor({ settingsPath });
    const check = report.checks.find((c) => c.name === 'node');
    expect(check?.detail).toBe(process.version);
  });
});
