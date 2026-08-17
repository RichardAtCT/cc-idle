# Corpus report — 2026-08-17

End-to-end proof of the backtesting pipeline (`ccidle corpus snapshot` →
`ccidle import` → `ccidle backtest`) against the real Claude Code history
available on this machine.

## Environment caveat

This run executed in a **remote Claude Code container**, where `~/.claude/projects/`
contains exactly one real transcript: this engagement's own live session
(project `/home/user/cc-idle`, CC v2.1.233). Richard's multi-month local history was
not reachable from here. The pipeline is machine-independent — on the local machine
the identical commands ingest the full history:

```sh
ccidle corpus snapshot        # archive raw transcripts first (survives CC's sweep)
ccidle import                 # full history → ~/.ccidle/corpus/
ccidle backtest --md-out docs/corpus-report-$(date +%F).md --json-out corpus-report.json
```

## Acceptance-criteria results (this machine)

1. **Full available history ingested without errors** — 1 session, 198 events
   synthesized, 0 malformed lines, zero writes under `~/.claude` (source tree
   verified unchanged; import reads only).
2. **Idempotent re-run** — second `ccidle import`: 0 imported / 1 unchanged via
   manifest fast-path, wall time **0.099 s** (< 2 s).
3. **Replay compatibility** — the imported session plays through `ccidle replay`
   (economy report produced; 198 events, 68K output tokens). A live-TUI visual
   spot-check needs a terminal with the daemon and is left for the local machine —
   the imported file is native-envelope JSONL, parsed by the same `parseEventLine`
   path the TUI's daemon uses.
4. **Deterministic backtest** — `ccidle backtest` run twice: JSON reports
   **byte-identical** (markdown too).
5. **Token reconciliation ±0** — sampled session `802a77bb-fc81-5acf-9d94-fdd19551aa6d`,
   imported TokenUsage totals vs. raw transcript (deduped by `message.id`, matching
   the v2.1.x streamed-line layout):
   input 89 / output 67,965 / cache-read 5,689,242 / cache-write 174,071 — exact on
   all four counters.
6. **Doctor retention warning** — fires on this machine's default settings
   (`cleanupPeriodDays` unset ⇒ `[WARN] transcript-retention`), and on the ≤30
   fixture in the test suite; doctor never edits `~/.claude/settings.json`.

Schema-variant details and synthesis mapping: see `docs/decisions.md`.

---

# CC Idle backtest report

## Corpus

- Event files replayed: 1
- Sessions: 1
- Events: 198
- Span: 2026-08-17T09:31:32.060Z → 2026-08-17T09:46:09.688Z (1 day(s))

## Totals

- Turns (UserPromptSubmit): 1
- Tool calls: 74 — 72 ok / 2 failed (97.3% ok)
- Subagent completions: 0
- Tokens: in 89 · out 67,965 · cache-r 5,689,242 · cache-w 174,071

| Model | Input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|
| claude-fable-5 | 89 | 67,965 | 5,689,242 | 174,071 |

## Projects (regions)

| Project | Sessions | Turns | Tool calls | Failures | Subagents | Output tokens |
|---|---:|---:|---:|---:|---:|---:|
| cc-idle (`/home/user/cc-idle`) | 1 | 1 | 74 | 2 | 0 | 67,965 |

### Tool calls by type

| Tool | Calls |
|---|---:|
| Bash | 23 |
| Read | 15 |
| Edit | 13 |
| Write | 8 |
| TaskUpdate | 7 |
| TaskCreate | 5 |
| Glob | 1 |
| Grep | 1 |
| ToolSearch | 1 |

## Activity histograms

### Events by hour of day (UTC)

```
00:00      0 
01:00      0 
02:00      0 
03:00      0 
04:00      0 
05:00      0 
06:00      0 
07:00      0 
08:00      0 
09:00    198 ████████████████████████████████████████
10:00      0 
11:00      0 
12:00      0 
13:00      0 
14:00      0 
15:00      0 
16:00      0 
17:00      0 
18:00      0 
19:00      0 
20:00      0 
21:00      0 
22:00      0 
23:00      0 
```

### Tokens by day

| Day | Input | Output |
|---|---:|---:|
| 2026-08-17 | 89 | 67,965 |

## Top 5 heaviest sessions (by output tokens)

| Session | Project | Events | Turns | Tool calls | Output tokens | Total tokens |
|---|---|---:|---:|---:|---:|---:|
| `802a77bb-fc81-5acf-9d94-fdd19551aa6d` | /home/user/cc-idle | 198 | 1 | 74 | 67,965 | 5,931,367 |

## Economy (game engine replay)

```json
{
  "eventsProcessed": 198,
  "outputTokensSeen": 67965,
  "computeFromTokens": 56572.95161636105,
  "computeFromCompletionBonus": 13609.677904090264,
  "computeFromStopBonus": 20,
  "computeFromTraining": 0,
  "computeSpent": 0,
  "engineeringFromTools": 84,
  "engineeringFromPostMortems": 0,
  "engineeringSpent": 0,
  "researchFromTools": 17,
  "researchSpent": 0,
  "reputationEarned": 1,
  "toolSuccesses": 72,
  "toolFailures": 2,
  "incidentsSpawned": 2,
  "incidentsAcked": 0,
  "trainingRuns": 0,
  "experiments": 0,
  "generationsShipped": 0,
  "breakthroughsEarned": 0,
  "breakthroughsSpent": 0
}
```

## Known gaps in imported data

- Notification events (permission prompts / idle alerts) leave no transcript trace and are not reconstructed — no HUMAN_ACTIVE signal exists in imported data.
- tmux pane fields are runtime-only and absent from imported envelopes.
- Stop timing is approximated by the last assistant message of each turn.
- Estimated cost is omitted: the repo has no model price table.
