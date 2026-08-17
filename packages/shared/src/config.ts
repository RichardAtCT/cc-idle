import { z } from 'zod';
import fs from 'node:fs';
import { configPath } from './paths.js';

/** ~/.ccidle/config.json (PRD §6). Every value overridable via CCIDLE_* env. */
export const ConfigSchema = z.object({
  focus: z
    .object({
      enabled: z.boolean().default(true),
      graceMs: z.number().int().nonnegative().default(3000),
      dwellMs: z.number().int().nonnegative().default(5000),
      /** Manual focus change suppresses auto-switch for this long. */
      manualCooldownMs: z.number().int().nonnegative().default(10000)
    })
    .default({}),
  alerts: z
    .object({
      bell: z.boolean().default(true),
      banner: z.boolean().default(true)
    })
    .default({}),
  tmux: z
    .object({
      autoLayout: z.boolean().default(true)
    })
    .default({}),
  log: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      maxFileMB: z.number().positive().default(5),
      retentionDays: z.number().int().positive().default(30),
      /** Regexes applied to payload text before it is written to disk. */
      redactPatterns: z
        .array(z.string())
        .default([
          'sk-[A-Za-z0-9-]{10,}',
          'ghp_[A-Za-z0-9]{20,}',
          'github_pat_[A-Za-z0-9_]{20,}',
          'AKIA[0-9A-Z]{16}',
          'xox[baprs]-[A-Za-z0-9-]{10,}',
          '-----BEGIN [A-Z ]*PRIVATE KEY-----'
        ])
    })
    .default({}),
  session: z
    .object({
      /** CC_WORKING with no events for this long → STALE; 2× → DEAD. */
      staleAfterMs: z.number().int().positive().default(300000),
      /** Transcript poll interval while CC_WORKING. */
      tokenPollMs: z.number().int().positive().default(10000)
    })
    .default({})
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

/**
 * Env overrides: CCIDLE_<SECTION>_<KEY>, e.g. CCIDLE_FOCUS_GRACEMS=1000,
 * CCIDLE_FOCUS_ENABLED=false, CCIDLE_LOG_LEVEL=debug.
 * Key match is case-insensitive against the config schema's camelCase keys.
 */
export function applyEnvOverrides(config: Config, env: NodeJS.ProcessEnv = process.env): Config {
  const next: Record<string, Record<string, unknown>> = structuredClone(config) as never;
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('CCIDLE_') || value === undefined) continue;
    const parts = name.slice('CCIDLE_'.length).split('_');
    if (parts.length < 2) continue;
    const sectionName = parts[0]!.toLowerCase();
    // Normalize by dropping underscores so both CCIDLE_LOG_RETENTIONDAYS and
    // CCIDLE_LOG_RETENTION_DAYS match the camelCase `retentionDays` key.
    const keyName = parts.slice(1).join('').toLowerCase();
    const section = next[sectionName];
    if (!section || typeof section !== 'object') continue;
    const key = Object.keys(section).find((k) => k.toLowerCase() === keyName);
    if (!key) continue;
    const current = section[key];
    if (typeof current === 'boolean') {
      section[key] = value === 'true' || value === '1';
    } else if (typeof current === 'number') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) section[key] = parsed;
    } else if (Array.isArray(current)) {
      section[key] = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      section[key] = value;
    }
  }
  const result = ConfigSchema.safeParse(next);
  return result.success ? result.data : config;
}

/**
 * Load config from disk (missing/invalid file falls back to defaults,
 * partial files deep-merge with defaults via zod), then apply env overrides.
 */
export function loadConfig(path: string = configPath(), env: NodeJS.ProcessEnv = process.env): Config {
  let fromDisk: Config = DEFAULT_CONFIG;
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const parsed = ConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) fromDisk = parsed.data;
  } catch {
    // missing or unreadable config → defaults
  }
  return applyEnvOverrides(fromDisk, env);
}
