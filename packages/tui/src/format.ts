import type { SessionSnapshot } from '@ccidle/shared';

/** First 8 chars of a session id — enough to eyeball, short enough for a row. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** Sum of input+output tokens across every model this session has used. */
export function totalTokens(session: SessionSnapshot): number {
  let total = 0;
  for (const totals of Object.values(session.tokensByModel)) {
    total += totals.inputTokens + totals.outputTokens;
  }
  return total;
}

/** Last path segment of a cwd, or '?' when unknown. */
export function cwdBasename(cwd?: string): string {
  if (!cwd) return '?';
  const trimmed = cwd.replace(/\/+$/, '');
  if (trimmed === '') return '/';
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) || '/' : trimmed;
}

/** Format a millisecond duration as mm:ss (clamped to non-negative). */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Elapsed mm:ss between an ISO timestamp and `now` (ms epoch). Invalid input reads as 00:00. */
export function elapsedSince(isoTimestamp: string, now: number): string {
  const since = Date.parse(isoTimestamp);
  if (Number.isNaN(since)) return '00:00';
  return formatElapsed(now - since);
}

const SPARK_GLYPHS = ['⠀', '⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;

/** Braille sparkline of non-negative samples, scaled to the sample max. */
export function sparkline(samples: number[], width = 30): string {
  const windowed = samples.slice(-width);
  if (windowed.length === 0) return '';
  const max = Math.max(...windowed);
  if (max <= 0) return SPARK_GLYPHS[0].repeat(windowed.length);
  return windowed
    .map((value) => {
      const idx = Math.min(SPARK_GLYPHS.length - 1, Math.ceil((value / max) * (SPARK_GLYPHS.length - 1)));
      return SPARK_GLYPHS[Math.max(0, idx)];
    })
    .join('');
}

/** Text progress bar like ▰▰▰▱▱▱▱ clamped to [0, 1]. */
export function progressBar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
