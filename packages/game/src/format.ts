/** Compact human number formatting shared by the engine's narration and the TUI. */
export function formatAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return trim(value / 1e12) + 'T';
  if (abs >= 1e9) return trim(value / 1e9) + 'B';
  if (abs >= 1e6) return trim(value / 1e6) + 'M';
  if (abs >= 1e3) return trim(value / 1e3) + 'K';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

function trim(scaled: number): string {
  const fixed = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}
