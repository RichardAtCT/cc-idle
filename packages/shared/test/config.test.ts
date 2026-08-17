import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema, DEFAULT_CONFIG, applyEnvOverrides, loadConfig } from '../src/config.js';

describe('config', () => {
  it('produces PRD defaults from an empty object', () => {
    expect(DEFAULT_CONFIG.focus).toMatchObject({ enabled: true, graceMs: 3000, dwellMs: 5000 });
    expect(DEFAULT_CONFIG.alerts).toEqual({ bell: true, banner: true });
    expect(DEFAULT_CONFIG.tmux).toEqual({ autoLayout: true });
    expect(DEFAULT_CONFIG.log.level).toBe('info');
    expect(DEFAULT_CONFIG.log.maxFileMB).toBe(5);
    expect(DEFAULT_CONFIG.log.retentionDays).toBe(30);
  });

  it('deep-merges partial config with defaults', () => {
    const parsed = ConfigSchema.parse({ focus: { graceMs: 1000 } });
    expect(parsed.focus.graceMs).toBe(1000);
    expect(parsed.focus.dwellMs).toBe(5000);
    expect(parsed.alerts.bell).toBe(true);
  });

  it('applies CCIDLE_* env overrides with type coercion', () => {
    const config = applyEnvOverrides(DEFAULT_CONFIG, {
      CCIDLE_FOCUS_GRACEMS: '1500',
      CCIDLE_FOCUS_ENABLED: 'false',
      CCIDLE_LOG_LEVEL: 'debug',
      CCIDLE_ALERTS_BELL: '0'
    });
    expect(config.focus.graceMs).toBe(1500);
    expect(config.focus.enabled).toBe(false);
    expect(config.log.level).toBe('debug');
    expect(config.alerts.bell).toBe(false);
  });

  it('matches multi-word keys with or without underscores', () => {
    const config = applyEnvOverrides(DEFAULT_CONFIG, {
      CCIDLE_LOG_RETENTION_DAYS: '7',
      CCIDLE_FOCUS_GRACE_MS: '2000'
    });
    expect(config.log.retentionDays).toBe(7);
    expect(config.focus.graceMs).toBe(2000);
  });

  it('ignores unknown or malformed env overrides', () => {
    const config = applyEnvOverrides(DEFAULT_CONFIG, {
      CCIDLE_NOPE_KEY: 'x',
      CCIDLE_FOCUS_GRACEMS: 'not-a-number'
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('loads from disk and falls back to defaults when missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-test-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ focus: { dwellMs: 9000 } }));
    const config = loadConfig(file, {});
    expect(config.focus.dwellMs).toBe(9000);
    expect(config.focus.graceMs).toBe(3000);

    const missing = loadConfig(path.join(dir, 'nope.json'), {});
    expect(missing).toEqual(DEFAULT_CONFIG);

    fs.writeFileSync(file, '{broken');
    expect(loadConfig(file, {})).toEqual(DEFAULT_CONFIG);
  });
});
