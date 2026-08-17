# Backtesting — Discovery Findings & Decisions

Findings from the Section-1 discovery pass of `docs` (the backtesting handoff), recorded
before building `ccidle import` / `ccidle backtest` / `ccidle corpus snapshot`.
Where the original PRD spec and the code disagree, the code wins (per the handoff).

## 1. Codebase as built

### Event envelope & JSONL layout (authoritative: `packages/shared/src/events.ts`)

One JSON object per line in `~/.ccidle/events/{session_id}.jsonl`:

```json
{"v":1,"ts":"2026-08-17T10:14:03.201Z","session_id":"abc-123","event":"PostToolUse","tool":"Bash","cwd":"/home/user/project","pane":"%3","payload":{}}
```

- `v` is `z.literal(1)`; `ts` is a plain string (ISO 8601 by convention, not validated).
- `event` is any non-empty string; known names: SessionStart, SessionEnd, UserPromptSubmit,
  PreToolUse, PostToolUse, Stop, SubagentStop, Notification, TokenUsage (daemon-synthetic).
- `tool`, `cwd`, `pane` optional; `payload` defaults to `{}`.
- **The schema is `.passthrough()`** — extra top-level keys survive `parseEventLine` →
  `serializeEvent`. The importer therefore tags envelopes with a top-level
  `origin: "import"` key; live and imported data can never be confused, and every
  existing consumer (replay, daemon watcher, game engine) ignores the extra key.
- Payloads > 4096 bytes are replaced by the hook shim with `{truncated:true, tool_name?}` —
  the importer applies the identical rule so files are shape-compatible.
- Filenames: `eventFilePath()` sanitises the session id (`/`,`\` → `_`) and appends `.jsonl`.
  The corpus uses the same convention.

### `ccidle replay` as built (`packages/cli/src/replay.ts`)

`ccidle replay <session.jsonl>... [--speed <x>] [--json] [--quiet]` — one or more explicit
**files** (no directory support), merged into a single timeline via `mergeTimelines`
(stable sort by `Date.parse(ts)`, input order breaks ties). `--speed` paces by envelope
timestamps ÷ speed capped at 5 s per gap; default is instant. Replay is a pure
engine run (`replayEnvelopes`) — deterministic, no wall clock, no daemon/TUI/tmux.
Backtest reuses exactly this path (`parseEventFile` + `mergeTimelines` +
`replayEnvelopes` from `@ccidle/game`).

### Session / region identity (`packages/game/src/engine.ts` `resolveRegion`)

- Sessions are keyed by `session_id`; **regions are keyed by the raw `cwd` string**
  (region id = cwd, display name = basename). A session's region is learned from the
  first envelope that carries a `cwd` and remembered in `state.sessionRegions`.
- Imported envelopes therefore carry the transcript line's own `cwd` field per event,
  which attributes them to the same regions a live session in that directory would get.
- Tool failure detection reads `payload.success === false` or
  `payload.tool_response.{success===false | is_error===true | error:string}`.
  The importer emits `payload: {tool_name, tool_response: {is_error}}` accordingly.
- `SubagentStop` duration is read from `payload.duration_ms` (or `durationMs`/
  `total_duration_ms`), capped by balance; the importer emits `duration_ms`.
- `TokenUsage` payload must match `TokenUsagePayloadSchema`:
  `{byModel: {<model>: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}}}`.

### CLI conventions (`packages/cli/src/cli.ts`)

- Plain `node:util` `parseArgs` per subcommand; no framework. Commands live one-per-module
  (`runReplay`, `runDoctor`, …) returning an exit code, taking an options object with
  injectable `out` / `env` for tests; `index.ts` re-exports every module.
- Tests are vitest, fixture dirs via `fs.mkdtempSync`, `CCIDLE_HOME`-style env injection.
- Config: `~/.ccidle/config.json` (zod, `loadConfig`), incl. `log.redactPatterns`
  (regex strings). `CCIDLE_HOME` overrides the home dir everywhere via `paths.ts`.

## 2. Real transcripts as found (`~/.claude/projects/<encoded-cwd>/`)

Inspected read-only on this machine (a remote Claude Code container). **Only the live
session's own transcript exists here** — `projects/-home-user-cc-idle/<session-uuid>.jsonl`,
CC version `2.1.233`. Richard's multi-month history lives on his local machine; the schema
facts below are from the genuine current-format transcript plus known older layouts, and
the importer treats every field defensively (missing ⇒ skip/count, never abort).

### Layout

- Project dir name = cwd with every non-alphanumeric character replaced by `-`
  (`/home/user/cc-idle` → `-home-user-cc-idle`). The encoding is lossy, so the importer
  **never decodes it** — the real cwd is taken from each line's `cwd` field. `--project`
  filters match against the encoded folder name (raw arg, glob, or encoded arg).
- One `<session-uuid>.jsonl` per session, plus an optional `<session-uuid>/` sidecar dir.
  Subagent transcripts, when present, are `<session-uuid>/subagents/*.jsonl`.

### Line schema (v2.1.x, observed)

Top-level keys per line: `type` (`user` | `assistant` | `attachment` | `queue-operation` |
`last-prompt` — older versions also `summary` / `system`), `timestamp` (ISO 8601),
`sessionId`, `cwd`, `uuid`, `parentUuid`, `isSidechain`, `gitBranch`, `version`,
`requestId` (assistant only), `toolUseResult` (tool-result user lines), `isMeta`,
`origin`/`promptSource` (real prompts).

- **Assistant lines**: `message.model`, `message.id` (`msg_…`), `message.usage`
  with `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens` (exactly the fields `daemon/transcripts.ts` already reads).
  **Critical quirk: one API response is split across several JSONL lines (one per content
  block), each repeating the same `message.id` and the identical `usage` object.**
  Naively summing per line multiplies token counts ~3-4×. The importer deduplicates usage
  by `message.id` (fallback `requestId`, then `uuid`) — one TokenUsage envelope per API
  response. The live daemon path never hit this because pre-2.1 transcripts carried usage
  once per response; documented here as the main schema-variant trap.
- **User lines**: real prompts have string `message.content` (or text blocks) and no
  `toolUseResult`; tool results have `message.content: [{type:"tool_result",
  tool_use_id, is_error?}]` plus a `toolUseResult` echo. `isMeta:true` lines are
  CC-internal and are not prompts.
- **tool_use / tool_result pairing**: assistant `tool_use` blocks carry `id`+`name`;
  results reference `tool_use_id`. `is_error` is `true`/`false`/absent (absent ⇒ success).
- **Sidechains/subagents**: `isSidechain: true` lines share the parent session's file and
  `sessionId` (older layout); chains are grouped by walking `parentUuid` to the chain
  root. Newer layout puts each subagent in `<session-uuid>/subagents/*.jsonl`.
- **Non-event lines**: `attachment`, `queue-operation`, `last-prompt`, `summary`,
  `system`, `progress` etc. carry no billable usage and map to no hook event — skipped
  and counted as metadata, never as malformed.

### Schema variants handled by the importer

| Variant | Where seen | Handling |
|---|---|---|
| v2.1.x streamed: usage repeated per content-block line, `message.id`/`requestId` present | this machine (2.1.233) | dedupe usage by `message.id` |
| pre-streaming: one line per response, no `requestId`, no repeat | older CC (fixture) | dedupe key falls back to `uuid`; behaves as before |
| minimal/legacy usage: no `cache_*_input_tokens` fields | early CC (fixture) | missing fields ⇒ 0 (same as daemon reader) |
| string `message.content` on user lines | both | treated as the prompt text |
| inline `isSidechain:true` subagents | older CC (fixture) | grouped by parentUuid chain → SubagentStop |
| `subagents/*.jsonl` sidecar files | current CC | one SubagentStop per file, duration = last−first ts |
| malformed / truncated lines | any | skipped + counted, never abort the file |

## 3. Event synthesis mapping (import)

| Synthesized envelope | Source | ts | Notes |
|---|---|---|---|
| SessionStart | first parseable line | first ts | payload `{source:"import", version?}` |
| UserPromptSubmit | non-meta user line w/ prompt content, main chain only | line ts | payload `{prompt}` (redacted, 4 KB truncation rule) |
| PreToolUse | each assistant `tool_use` block (incl. sidechains — live hooks fire for subagent tools too) | line ts | `tool` + payload `{tool_name, tool_input}` (truncation rule) |
| PostToolUse | each `tool_result` block | line ts | payload `{tool_name, tool_response:{is_error}}` |
| TokenUsage | per unique `message.id` with usage (main + sidechains + subagent files) | first line of that response | payload matches `TokenUsagePayloadSchema`; subagent usage attributed to the parent session |
| Stop | last assistant line before the next real prompt / EOF | that assistant line's ts | one per completed turn |
| SubagentStop | sidechain chain root / subagent file | chain's last ts | payload `{duration_ms}` when derivable |
| SessionEnd | last parseable line | last ts | payload `{source:"import"}` |

**Not reconstructable — omitted, never fabricated:** `Notification` events (permission
prompts / idle alerts leave no transcript trace) and the `pane` field (tmux pane ids are
runtime-only). Consequence for backtests: no HUMAN_ACTIVE / needs-you signal exists in
imported corpora, and stop-bonus timing is approximated by the last assistant message of
each turn. Documented in every backtest report.

Original timestamps are preserved verbatim; replay owns time compression (unchanged).

## 4. Other decisions

- **Corpus location**: `~/.ccidle/corpus/` (`corpusDir()` in shared paths, honours
  `CCIDLE_HOME`), one `<session_id>.jsonl` per historical session; raw snapshots go to
  `~/.ccidle/corpus-raw/<YYYY-MM-DD>/`. Manifest: `~/.ccidle/corpus/manifest.json` keyed
  by absolute source path, storing size+mtime (fast path) and sha256 (truth) over the main
  file plus its subagent files — unchanged sources are skipped without re-hashing.
- **Read-only guarantee**: the importer and snapshotter open `~/.claude` files with plain
  reads only; nothing under `--claude-dir` is ever created, modified, or deleted.
- **Redaction**: `log.redactPatterns` from the existing config are compiled as global
  regexes and applied to every string inside synthesized payloads before writing
  (equivalent to the hook shim's pre-write `redact.sed` pass; invalid patterns skipped).
- **Backtest** is headless by construction: it uses only `@ccidle/game` pure functions and
  local file reads — no daemon socket, no tmux, no TUI imports. Reports are deterministic:
  stable key ordering, no wall-clock values in the JSON output.
- **Estimated cost**: the repo has no price table (`balance.ts` is game tuning, not $) —
  cost estimation is omitted rather than inventing prices; the report notes the gap.
- **`BacktestSink`**: `{ name; onEvent(envelope); summary() }` — the telemetry report is
  the first implementation; M1's economy simulator later plugs into the same harness.
- **Doctor**: new `transcript-retention` check warns when `cleanupPeriodDays` in
  `~/.claude/settings.json` is unset or ≤ 30 (recommendation: a large value like 3650,
  not 0). Doctor only warns; it never edits that file.
