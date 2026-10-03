import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Model price table (config/prices.json).
 *
 * Every figure here is a published list rate, not what anyone actually pays:
 * negotiated discounts, the Batch API discount, the us-only inference-geo
 * multiplier and fast mode all move the real number. So costs derived from this
 * table are labelled approximate wherever they are shown, and a model missing
 * from the table renders as "n/a" — a guessed rate would be worse than no rate.
 */

export interface ModelPrice {
  displayName?: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  note?: string;
}

export interface PriceTable {
  metadata: {
    currency: string;
    unit: string;
    source: string;
    retrieved: string;
    note?: string;
  };
  unknownModel: { policy: string; display: string; note?: string };
  models: Record<string, ModelPrice>;
  aliases: Record<string, string>;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Per-category cost in USD, or null when the model has no published rate. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const PER_MILLION = 1_000_000;

/**
 * Walks up from this module looking for config/prices.json, so the table
 * resolves the same whether it is loaded from src (tests) or dist (the CLI).
 */
export function findPriceTablePath(startDir?: string): string | null {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, 'config', 'prices.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: PriceTable | null | undefined;

/** Loads the table, or null when it is missing or unreadable. Cost columns then read "n/a". */
export function loadPriceTable(explicitPath?: string): PriceTable | null {
  if (explicitPath === undefined && cached !== undefined) return cached;
  const file = explicitPath ?? findPriceTablePath();
  let table: PriceTable | null = null;
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PriceTable;
      if (parsed && typeof parsed === 'object' && parsed.models) table = parsed;
    } catch {
      table = null; // unreadable table behaves exactly like a missing one
    }
  }
  if (explicitPath === undefined) cached = table;
  return table;
}

/** Test seam: drops the module-level cache. */
export function resetPriceTableCache(): void {
  cached = undefined;
}

/** Resolves a model id through the alias map. Returns null when unpriced. */
export function priceFor(table: PriceTable | null, model: string): ModelPrice | null {
  if (!table) return null;
  const direct = table.models[model];
  if (direct) return direct;
  const aliased = table.aliases?.[model];
  return aliased ? (table.models[aliased] ?? null) : null;
}

/**
 * Costs a token bundle. Cache writes are charged at the 5-minute rate: the
 * transcripts record no TTL, and 5m is what the hooks' own traffic uses.
 */
export function costOf(price: ModelPrice | null, tokens: TokenCounts): ModelCost | null {
  if (!price) return null;
  const input = (tokens.inputTokens / PER_MILLION) * price.input;
  const output = (tokens.outputTokens / PER_MILLION) * price.output;
  const cacheRead = (tokens.cacheReadTokens / PER_MILLION) * price.cacheRead;
  const cacheWrite = (tokens.cacheWriteTokens / PER_MILLION) * price.cacheWrite5m;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** Renders USD for the report; unpriced models get the table's "n/a" marker. */
export function formatUsd(value: number | null, unknownDisplay = 'n/a'): string {
  if (value === null) return unknownDisplay;
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
